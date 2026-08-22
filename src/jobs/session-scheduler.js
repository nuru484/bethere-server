// src/jobs/session-scheduler.js
import { Queue } from "bullmq";
import { addDays } from "date-fns";
import { prisma } from "../config/prisma-client.js";
import { createRedisConnection } from "../config/redis-connection.js";
import { dueSessionCreation } from "../services/session-planning.js";
import { eventCalendarDay } from "../utils/time-context.js";
import { sessionQueue } from "./session-queue.js";
import logger from "../utils/logger.js";

export const sessionSchedulerQueue = new Queue("sessionScheduler", {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    // Daily repeats: keep a short bounded trail for debugging instead of
    // accumulating a row per day forever.
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 100 },
  },
});

/**
 * Daily sweep AND catch-up: enqueues session creation for every event whose
 * next occurrence is due (target day <= tomorrow). The worker self-schedules
 * the next occurrence, but that chain lives only in Redis, so a flush or a
 * worker outage during the window would strand the event forever if this sweep
 * matched only targets EXACTLY equal to tomorrow. Enqueueing anything already
 * due is safe: the worker checks for existing rows and creates with
 * skipDuplicates.
 */
export async function scheduleUpcomingSessions() {
  logger.info("🔍 Checking for events needing session creation...");

  // The venue's tomorrow as a UTC day start - the same convention session
  // rows are stored with (see utils/time-context.js).
  const tomorrow = addDays(eventCalendarDay(), 1);
  const today = eventCalendarDay();

  // Only events that can still need sessions: ones with no session rows at
  // all (first occurrence never materialized) and recurring ones. An
  // unfiltered findMany would drag every finished one-off event through the
  // sweep on every run. Archived events are excluded here and skipped again
  // in the worker: archiving an event must stop it generating sessions.
  // (Soft-deleted ones are already scoped out by the Prisma extension on
  // findMany.)
  const events = await prisma.event.findMany({
    where: {
      archived: false,
      OR: [{ sessions: { none: {} } }, { isRecurring: true }],
      // Long-finished events can never need sessions again; without this the
      // sweep drags every ended recurring event through dueSessionCreation
      // on every run, forever. gte today, not tomorrow: an event ending
      // today may still need today's catch-up session.
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: today } }] }],
    },
    include: {
      sessions: {
        orderBy: { startDate: "desc" },
        take: 1,
      },
    },
  });

  let scheduledCount = 0;

  for (const event of events) {
    const due = dueSessionCreation(
      {
        isRecurring: event.isRecurring,
        startDate: event.startDate,
        endDate: event.endDate,
        durationDays: event.durationDays,
        recurrenceInterval: event.recurrenceInterval,
        lastSessionStartDate: event.sessions[0]?.startDate ?? null,
      },
      tomorrow
    );

    if (!due) continue;

    if (due.pastDue) {
      // A past-due target means the worker's self-scheduling chain was lost;
      // surfacing it makes a silent stall visible in the logs.
      logger.warn(
        `⏰ Catch-up: event "${event.title}" (ID: ${event.id}) was due ` +
          `${due.targetDate.toISOString().slice(0, 10)}; enqueueing now`
      );
    }

    const delay = due.targetDate.getTime() - Date.now();
    await sessionQueue.add(
      "createSession",
      { eventId: event.id },
      delay > 0 ? { delay } : {}
    );

    scheduledCount++;
    logger.info(
      `📅 Scheduled session creation for event "${event.title}" (ID: ${event.id})`
    );
  }

  logger.info(`✅ Scheduled ${scheduledCount} session(s) for creation`);
  return scheduledCount;
}
