// src/services/session-planning.js
//
// ALL recurrence/occurrence date arithmetic for session generation lives
// here, and nowhere else. The scheduler sweep, the session worker, and the
// event update path all answer "when is the next occurrence" from this one
// module: separate copies drift apart (over the multi-day step-back, over
// server-local versus UTC midnight) and a multi-day recurring event then gets
// scheduled for different days depending on which code path fired. Pure on
// purpose: no Redis, no database, unit-testable date math.
import { addUtcDays, utcDayAtTime, utcDayStart } from "../utils/time-context.js";

/** An event's occurrence length in days; missing/zero reads as one day. */
const occurrenceLengthDays = (durationDays) => Math.max(1, durationDays || 1);

/**
 * The start day (UTC midnight) of the occurrence AFTER the one that ended
 * with `lastSessionStartDate`.
 *
 * Sessions are stored one row PER DAY, so the newest row is the LAST day of
 * the previous occurrence; step back durationDays - 1 to that occurrence's
 * first day before adding the interval, or a multi-day event drifts by
 * durationDays - 1 on every recurrence.
 *
 * The result is always AFTER the last stored day. A recurrenceInterval
 * shorter than durationDays (rejected on write, but legacy rows carry it)
 * otherwise computes a day that already has a row: the worker answers
 * "skipped" before it can chain the next job, the chain dies, and the daily
 * sweep re-enqueues the same stalled event forever without ever producing a
 * second occurrence.
 */
export function nextOccurrenceStart(
  lastSessionStartDate,
  { durationDays, recurrenceInterval }
) {
  const lastDay = utcDayStart(lastSessionStartDate);
  const occurrenceStart = addUtcDays(
    lastDay,
    -(occurrenceLengthDays(durationDays) - 1)
  );
  const next = addUtcDays(occurrenceStart, recurrenceInterval);
  return next > lastDay ? next : addUtcDays(lastDay, 1);
}

/**
 * Plans the Session rows for ONE occurrence of an event: one row PER DAY.
 *
 * Attendance is unique on (userId, sessionId), so a single row spanning a
 * multi-day event would mean one check-in for the ENTIRE span and a Mon-Fri
 * conference could only ever record a single day per attendee. A day per row
 * makes attendance per day, which is what a "session" means everywhere else in
 * the product.
 */
export function planOccurrenceSessions({
  eventId,
  occurrenceStart,
  durationDays,
  startTime,
  endTime,
  eventEndDate = null,
}) {
  const lastAllowedDay = eventEndDate ? utcDayStart(eventEndDate) : null;
  const firstDay = utcDayStart(occurrenceStart);

  const rows = [];
  for (let offset = 0; offset < occurrenceLengthDays(durationDays); offset++) {
    // UTC throughout for both the day walk and the time-of-day placement: on
    // the SERVER's local calendar, a local DST transition inside the occurrence
    // yields a startDate that is not UTC midnight - and that column is half of
    // Session's @@unique([eventId, startDate]), so the same calendar day can be
    // inserted twice.
    const day = addUtcDays(firstDay, offset);
    // Never run an occurrence past the event's own end date.
    if (lastAllowedDay && day > lastAllowedDay) break;

    rows.push({
      eventId,
      startDate: day,
      endDate: day,
      startTime: utcDayAtTime(day, startTime),
      endTime: utcDayAtTime(day, endTime),
    });
  }

  return rows;
}

/**
 * The daily sweep's decision: does this event need session creation, and for
 * which day? `tomorrow` is a UTC day start (the venue's tomorrow).
 *
 * Returns null when nothing is due, otherwise { targetDate, pastDue }.
 * pastDue means the target already slipped behind the sweep window - the
 * worker's self-scheduling chain was lost (Redis flush, worker downtime) -
 * and the caller should enqueue immediately instead of waiting for an exact
 * date match that will never come again. Repeat enqueues are safe: the
 * worker checks for existing rows and creates with skipDuplicates.
 */
export function dueSessionCreation(
  {
    isRecurring,
    startDate,
    endDate,
    durationDays,
    recurrenceInterval,
    lastSessionStartDate,
  },
  tomorrow
) {
  let targetDate;

  if (!lastSessionStartDate) {
    // First occurrence never materialized: target the event's own start.
    targetDate = utcDayStart(startDate);
  } else if (isRecurring) {
    targetDate = nextOccurrenceStart(lastSessionStartDate, {
      durationDays,
      recurrenceInterval,
    });
  } else {
    // Non-recurring with sessions: nothing more to plan, ever.
    return null;
  }

  // Never plan past the event's own end date.
  if (endDate && targetDate > utcDayStart(endDate)) return null;

  // Not yet due: the worker's own chain (or a later sweep) will get there.
  if (targetDate > tomorrow) return null;

  return { targetDate, pastDue: targetDate < tomorrow };
}
