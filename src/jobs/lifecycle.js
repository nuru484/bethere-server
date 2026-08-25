// src/jobs/lifecycle.js
//
// Shared BullMQ worker lifecycle for both entrypoints: server.js runs the
// workers in-process by default (single deployment) and worker.js is the
// dedicated worker entry. Imports are lazy so a web process with
// WEB_DISABLE_WORKERS=true never opens a Redis connection for them.
import { captureError } from "../lib/sentry.js";
import logger from "../utils/logger.js";

let running = null;

/**
 * (Re-)registers a repeatable job with the current cron pattern. Repeat
 * schedules are keyed by their pattern, so changing the cron in code merely
 * ADDS a second schedule while the old one keeps firing forever - any
 * schedule for this job name whose pattern differs is removed first.
 */
async function ensureRepeatableJob(queue, name, pattern) {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === name && job.pattern !== pattern) {
      await queue.removeRepeatableByKey(job.key);
      logger.info(
        `Removed stale repeat schedule for ${name} (${job.pattern} -> ${pattern})`
      );
    }
  }
  await queue.add(name, {}, { repeat: { pattern } });
}

/** Job-failure reporting shared by every worker: log + Sentry (DSN-gated). */
function reportJobFailure(queueName) {
  return (job, err) => {
    const requestId = job?.data?.requestId;
    logger.error({ err, requestId }, `${queueName} job ${job?.id} failed`);
    captureError(err, {
      requestId,
      queue: queueName,
      jobId: job?.id,
      jobName: job?.name,
      jobData: job?.data,
      attemptsMade: job?.attemptsMade,
    });
  };
}

export async function startWorkers() {
  if (running) return running;

  const [
    { createSessionWorker },
    scheduler,
    { tokenCleanupQueue },
    { sessionQueue },
    { sessionFinalizerQueue },
    { createMailWorker },
    { mailQueue },
    { finalizeDueSessions },
    retentionService,
    bullmq,
    redis,
  ] = await Promise.all([
    import("./session-worker.js"),
    import("./session-scheduler.js"),
    import("./token-cleanup.js"),
    import("./session-queue.js"),
    import("./session-finalizer.js"),
    import("./mail-worker.js"),
    import("./mail-queue.js"),
    import("../services/session-finalizer.service.js"),
    import("../services/retention.service.js"),
    import("bullmq"),
    import("../config/redis-connection.js"),
  ]);

  const { sessionSchedulerQueue, scheduleUpcomingSessions } = scheduler;
  const { Worker } = bullmq;
  const { createRedisConnection } = redis;

  const sessionWorker = createSessionWorker();
  const mailWorker = createMailWorker();

  logger.info("Session and mail workers started and listening for jobs...");

  // Run the scheduler and finalizer immediately on startup, so a deploy that
  // was down over a boundary catches up without waiting for the next cron.
  scheduleUpcomingSessions().catch((err) => logger.error(err));
  finalizeDueSessions().catch((err) => logger.error(err));

  // Daily checks: session generation at midnight, token cleanup at 03:00.
  await ensureRepeatableJob(sessionSchedulerQueue, "dailyCheck", "0 0 * * *");
  await ensureRepeatableJob(tokenCleanupQueue, "dailyCleanup", "0 3 * * *");
  // Session finalization (absence marking + auto check-out): frequent, so a
  // finished session closes its books within minutes of the grace elapsing.
  const { SESSION_FINALIZER } = await import("../config/constants.js");
  await ensureRepeatableJob(
    sessionFinalizerQueue,
    "finalizeSessions",
    SESSION_FINALIZER.CRON_PATTERN
  );

  const schedulerWorker = new Worker(
    "sessionScheduler",
    async () => {
      await scheduleUpcomingSessions();
    },
    { connection: createRedisConnection() }
  );
  schedulerWorker.on("failed", reportJobFailure("sessionScheduler"));

  const tokenCleanupWorker = new Worker(
    "tokenCleanup",
    async () => {
      await retentionService.runRetention();
    },
    { connection: createRedisConnection() }
  );
  tokenCleanupWorker.on("failed", reportJobFailure("tokenCleanup"));

  const sessionFinalizerWorker = new Worker(
    "sessionFinalizer",
    async () => {
      await finalizeDueSessions();
    },
    { connection: createRedisConnection() }
  );
  sessionFinalizerWorker.on("failed", reportJobFailure("sessionFinalizer"));

  running = {
    workers: [
      sessionWorker,
      mailWorker,
      schedulerWorker,
      tokenCleanupWorker,
      sessionFinalizerWorker,
    ],
    // sessionQueue too: it holds its own Redis connection, and leaving it open
    // makes shutdown wait out the force-exit timer.
    queues: [
      sessionSchedulerQueue,
      tokenCleanupQueue,
      sessionQueue,
      sessionFinalizerQueue,
      mailQueue,
    ],
  };
  return running;
}

/** Closes every worker (waiting on in-flight jobs) and queue connection. */
export async function stopWorkers() {
  if (!running) return;
  const { workers, queues } = running;
  running = null;
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(queues.map((queue) => queue.close()));
}
