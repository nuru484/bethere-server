// src/services/session-finalizer.service.js
//
// Closes the books on finished sessions. It is the only writer of ABSENT:
// check-in creates PRESENT/LATE rows and nothing else, so without this sweep
// every absence metric reads zero and a user who checked in but never checked
// out keeps an open row forever.
//
// For every session whose daily window (event.endTime in the venue timezone,
// plus a grace period) has closed and that has not been finalized yet:
//   1. every active attendant WITHOUT a row for that session gets an ABSENT
//      row via one set-based INSERT ... SELECT (idempotent, race-safe, never
//      loading the user table into memory),
//   2. rows checked in but never out get checkOutTime stamped to the
//      session's end with autoCheckedOut = true, so the client can render
//      "signed out by system" - a real face-verified check-out it is not,
//   3. the session's finalizedAt is stamped, guarding the whole step against
//      re-runs.
// All three land in ONE transaction per session. The audit entry is written
// by the SYSTEM actor: the finalizer acts, never the user.
import { prisma } from "../config/prisma-client.js";
import { SESSION_FINALIZER } from "../config/constants.js";
import { addUtcDays, eventCalendarDay, eventTimeOnDay } from "../utils/time-context.js";
import { auditLogWrite } from "./audit.service.js";
import logger from "../utils/logger.js";

/**
 * Finalizes one session (already loaded with its event). Exported for tests.
 * Returns a summary or null when the session was already finalized (raced by
 * a concurrent sweep).
 */
export async function finalizeSession(session, { markAbsences, now = new Date() }) {
  const sessionEnd = eventTimeOnDay(session.startDate, session.event.endTime);

  return prisma.$transaction(async (tx) => {
    // Atomic claim: two overlapping sweeps cannot finalize the same session
    // twice (the loser reads count 0 and backs off).
    const claimed = await tx.session.updateMany({
      where: { id: session.id, finalizedAt: null },
      data: { finalizedAt: now },
    });
    if (claimed.count === 0) return null;

    let absentCreated = 0;
    let autoCheckedOut = 0;

    if (markAbsences) {
      // Set-based absence insert: one INSERT ... SELECT that the database
      // evaluates entirely server-side. Pulling every active user id into the
      // Node heap, diffing it against the session's rows in JS and inserting
      // the remainder would mean a huge array in memory and a giant multi-row
      // insert at tens of thousands of attendants, inside an open write
      // transaction that blows the interactive-transaction timeout and
      // silently stops marking absences.
      //
      // - deletedAt IS NULL spells out the Prisma soft-delete scope, which raw
      //   SQL bypasses along with the rest of the extension.
      // - NOT EXISTS skips users who already have any row for this session
      //   (a real check-in, or an absence from a raced sweep).
      // - ON CONFLICT DO NOTHING is the race guard: a check-in landing between
      //   the NOT EXISTS and the insert loses on the (userId, sessionId)
      //   unique index instead of failing the batch.
      // - updatedAt has no DB default (@updatedAt is applied by Prisma at the
      //   app layer, which a raw insert bypasses), so both timestamps are set.
      absentCreated = await tx.$executeRaw`
        INSERT INTO "Attendance" ("userId", "sessionId", "status", "createdAt", "updatedAt")
        SELECT u."id", ${session.id}, 'ABSENT'::"AttendanceStatus", NOW(), NOW()
        FROM "User" u
        WHERE u."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "Attendance" a
            WHERE a."sessionId" = ${session.id} AND a."userId" = u."id"
          )
        ON CONFLICT ("userId", "sessionId") DO NOTHING
      `;

      const closed = await tx.attendance.updateMany({
        where: {
          sessionId: session.id,
          checkInTime: { not: null },
          checkOutTime: null,
        },
        data: { checkOutTime: sessionEnd, autoCheckedOut: true },
      });
      autoCheckedOut = closed.count;
    }

    // SYSTEM attribution, in the same transaction: the audit trail must never
    // read as if the users signed themselves out.
    await auditLogWrite(
      {
        actorKind: "SYSTEM",
        actorId: null,
        action: "SESSION_FINALIZED",
        targetType: "Session",
        targetId: session.id,
        metadata: {
          eventId: session.eventId,
          absentCreated,
          autoCheckedOut,
          markAbsences,
        },
      },
      tx
    );

    return { sessionId: session.id, absentCreated, autoCheckedOut };
  }, {
    // The absence insert is one set-based statement, but on an event with tens
    // of thousands of attendants it still writes tens of thousands of rows, so
    // the default 5s interactive-transaction timeout is raised. maxWait covers
    // waiting for a connection when several sessions finalize back to back.
    timeout: 30_000,
    maxWait: 10_000,
  });
}

/**
 * The sweep: finds every unfinalized session whose window has closed and
 * finalizes it. Sessions older than the lookback are stamped finalized
 * WITHOUT absence marking - fabricating retroactive ABSENT rows for history
 * that predates this feature (or a long outage) would poison the data, and
 * users created after those sessions would read as absent from them.
 */
export async function finalizeDueSessions(now = new Date()) {
  const today = eventCalendarDay(now);
  const lookbackStart = addUtcDays(today, -SESSION_FINALIZER.LOOKBACK_DAYS);

  // SQL narrows to plausible candidates (unfinalized, day started); the
  // venue-timezone end-plus-grace cutoff needs the event's HH:MM string, so
  // it runs in JS on the already-small set.
  const candidates = await prisma.session.findMany({
    where: {
      finalizedAt: null,
      startDate: { lte: today },
    },
    include: { event: true },
    orderBy: { startDate: "asc" },
  });

  const summary = { finalized: 0, absentCreated: 0, autoCheckedOut: 0, skippedHistorical: 0 };

  for (const session of candidates) {
    const sessionEnd = eventTimeOnDay(session.startDate, session.event.endTime);
    if (now.getTime() - sessionEnd.getTime() < SESSION_FINALIZER.GRACE_MS) {
      continue; // Window (plus grace) still open.
    }

    // No retroactive absences for history beyond the lookback, nor for
    // sessions whose event was soft-deleted or archived after they ran -
    // those are stamped finalized so the sweep stops revisiting them.
    const markAbsences =
      session.startDate >= lookbackStart &&
      !session.event.deletedAt &&
      !session.event.archived;

    try {
      const result = await finalizeSession(session, { markAbsences, now });
      if (!result) continue;
      summary.finalized++;
      summary.absentCreated += result.absentCreated;
      summary.autoCheckedOut += result.autoCheckedOut;
      if (!markAbsences) summary.skippedHistorical++;
    } catch (error) {
      // One bad session must not stall the sweep; the next run retries it.
      logger.error(error, `Failed to finalize session ${session.id}`);
    }
  }

  if (summary.finalized > 0) {
    logger.info({ sessionFinalizer: summary }, "Session finalization sweep complete");
  }
  return summary;
}
