// src/jobs/session-worker.js
import { Worker } from "bullmq";
import { prisma } from "../config/prisma-client.js";
import { createRedisConnection } from "../config/redis-connection.js";
import { format } from "date-fns";
import { utcDayStart } from "../utils/time-context.js";
import {
  nextOccurrenceStart,
  planOccurrenceSessions,
} from "../services/session-planning.js";
import { captureError } from "../lib/sentry.js";
import logger from "../utils/logger.js";
import { sessionQueue } from "./session-queue.js";

/**
 * The job body, exported so its skip/creation decisions can be exercised
 * without standing up a BullMQ worker and a Redis round-trip.
 */
export async function processSessionJob(job) {
  const { eventId, requestId } = job.data;

  logger.info(
    { eventId, requestId },
    `Processing session creation for event: ${eventId}`
  );

  // findUnique on purpose (the soft-delete extension leaves it unscoped), so
  // deletedAt can be INSPECTED rather than silently hiding the row - a chained
  // job sitting in Redis from before the deletion must be recognised and
  // dropped, not fail as "not found".
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      sessions: {
        orderBy: { startDate: "desc" },
        take: 1,
      },
    },
  });

  if (!event) {
    // A plain Error on purpose: NotFoundError is an HTTP-layer type and a
    // BullMQ processor has no response to shape - the job just fails.
    throw new Error(`Event ${eventId} not found`);
  }

  // A delayed chain job outlives the change that stopped the event. Neither a
  // soft-deleted nor an archived event may gain sessions, and neither may
  // re-chain - returning here ends the chain for good.
  if (event.deletedAt || event.archived) {
    const reason = event.deletedAt ? "Event deleted" : "Event archived";
    logger.info(`${reason}; skipping session creation for event ${eventId}`);
    return { status: "skipped", reason };
  }

  // Determine the next session start date
  let sessionStartDate;

  if (event.sessions.length === 0) {
    // First session - use event's startDate
    sessionStartDate = utcDayStart(event.startDate);
  } else {
    // Recurring event - the shared planner steps back from the last stored
    // day to the previous occurrence's start before adding the interval.
    sessionStartDate = nextOccurrenceStart(event.sessions[0].startDate, {
      durationDays: event.durationDays,
      recurrenceInterval: event.recurrenceInterval,
    });
  }

  // Check if session already exists
  const existingSession = await prisma.session.findUnique({
    where: {
      eventId_startDate: {
        eventId: event.id,
        startDate: sessionStartDate,
      },
    },
  });

  if (existingSession) {
    logger.info(
      `Session already exists for event ${eventId} on ${sessionStartDate}`
    );

    return { status: "skipped", reason: "Session already exists" };
  }

  // Check if we should still create sessions (if event has endDate)
  if (event.endDate && sessionStartDate > new Date(event.endDate)) {
    logger.info(
      `Event ${eventId} has ended. No more sessions will be created.`
    );

    return { status: "completed", reason: "Event ended" };
  }

  // One row per day of this occurrence, so attendance is recorded per day.
  const plannedSessions = planOccurrenceSessions({
    eventId: event.id,
    occurrenceStart: sessionStartDate,
    durationDays: event.durationDays,
    startTime: event.startTime,
    endTime: event.endTime,
    eventEndDate: event.endDate,
  });

  // skipDuplicates keeps the job idempotent if it is retried part-way.
  const { count } = await prisma.session.createMany({
    data: plannedSessions,
    skipDuplicates: true,
  });

  const lastPlanned = plannedSessions[plannedSessions.length - 1];
  logger.info(
    `Created ${count} session(s) for event ${eventId}: ` +
      `${format(sessionStartDate, "yyyy-MM-dd")} -> ` +
      `${format(lastPlanned.startDate, "yyyy-MM-dd")} ` +
      `(${event.startTime}-${event.endTime})`
  );

  // If recurring, schedule the next session creation
  if (event.isRecurring) {
    // The planner's convention: the next occurrence starts strictly after the
    // last day this one just created, so a legacy recurrenceInterval shorter
    // than durationDays cannot chain onto a day that already has a row.
    const nextSessionDate = nextOccurrenceStart(lastPlanned.startDate, {
      durationDays: event.durationDays,
      recurrenceInterval: event.recurrenceInterval,
    });

    // Only schedule if within event's endDate (if set)
    if (!event.endDate || nextSessionDate <= new Date(event.endDate)) {
      const delay = nextSessionDate.getTime() - Date.now();

      if (delay > 0) {
        await sessionQueue.add(
          "createSession",
          { eventId: event.id, requestId },
          { delay }
        );
        logger.info(
          `Scheduled next session for ${format(
            nextSessionDate,
            "yyyy-MM-dd"
          )}`
        );
      }
    }
  }

  return {
    status: "success",
    sessionsCreated: count,
    startDate: sessionStartDate,
    endDate: lastPlanned.startDate,
  };
}

/**
 * Instantiates the session worker. A factory rather than a module-level
 * instance: constructing a BullMQ Worker opens a live Redis connection, and
 * doing that at import time would mean merely importing this module (from a
 * unit test, a script) spins one up. Only lifecycle.js should call this.
 */
export function createSessionWorker() {
  const worker = new Worker("sessionQueue", processSessionJob, {
    connection: createRedisConnection(),
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { err, requestId: job?.data?.requestId },
      `Session job ${job?.id} failed`
    );
    // DSN-gated no-op when Sentry is disabled (see lib/sentry.js).
    captureError(err, {
      queue: "sessionQueue",
      jobId: job?.id,
      jobName: job?.name,
      jobData: job?.data,
      attemptsMade: job?.attemptsMade,
    });
  });

  worker.on("completed", (job, result) => {
    logger.info(
      { ...result, requestId: job.data?.requestId },
      `Session job ${job.id} completed successfully`
    );
  });

  return worker;
}
