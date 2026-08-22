// src/utils/time-context.js

/**
 * Events store their daily attendance window as "HH:MM" strings, which are
 * only meaningful in the venue's timezone - comparing them against the
 * SERVER's local clock breaks the moment the host runs in UTC while the
 * venue is not (or vice versa). All wall-clock comparisons therefore go
 * through this helper, pinned to EVENT_TIMEZONE.
 */
import ENV from "../config/env.js";

/**
 * The venue's CALENDAR DAY for `now`, as a UTC-midnight Date.
 *
 * Session rows store date-only values, and "which day is it at the venue" has
 * to be asked the same way everywhere. Deriving it from the SERVER's local
 * midnight leaves a host in UTC and a venue in UTC+12 disagreeing about the
 * current day for half of it, refusing check-in all morning and opening it
 * during the previous venue evening.
 */
export function eventCalendarDay(now = new Date()) {
  // en-CA renders as YYYY-MM-DD, which is exactly the date-only key we want.
  const isoDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: ENV.EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  return new Date(`${isoDate}T00:00:00.000Z`);
}

/**
 * Normalizes an already date-only value (an event's startDate/endDate) to UTC
 * midnight WITHOUT re-interpreting it through a timezone, which would shift it
 * a day for negative offsets.
 */
export function utcDayStart(value) {
  const date = new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

/**
 * Adds whole days on the UTC calendar. date-fns' addDays walks the SERVER's
 * local calendar (it keeps the local wall time), so stepping a UTC-midnight
 * day across a local DST transition lands on 23:00 or 01:00 UTC instead of
 * midnight - and startDate is part of Session's @@unique([eventId, startDate]),
 * so an off-midnight value lets a second row exist for the same calendar day.
 */
export function addUtcDays(value, days) {
  const date = new Date(value);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + days,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

/** A UTC-midnight day with an "HH:MM" wall-clock time placed on it, in UTC. */
export function utcDayAtTime(day, timeString) {
  const [hour, minute] = timeString.split(":").map(Number);
  const date = new Date(day);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      minute,
      0,
      0
    )
  );
}

/** "HH:MM" for the current moment in the event timezone. */
export function currentTimeStringInEventTz(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ENV.EVENT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/**
 * The venue timezone's UTC offset at `date`, in milliseconds. Positive for
 * zones ahead of UTC. Computed from Intl.DateTimeFormat.formatToParts, which
 * is exact to the second, unlike a `new Date(toLocaleString(...))` round-trip,
 * which depends on V8 parsing a non-standard locale string and truncates to
 * whole seconds.
 */
function eventTzOffsetMs(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ENV.EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // hourCycle quirk: midnight can format as "24".
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hour,
    Number(get("minute")),
    Number(get("second")),
    date.getMilliseconds()
  );
  return asUtc - date.getTime();
}

/**
 * A Date for today's "HH:MM" in the event timezone, built from `now`. Used
 * to compare check-in instants against the window edges.
 */
export function todayAtEventTime(timeString, now = new Date()) {
  const [hour, minute] = timeString.split(":").map(Number);
  const offsetMs = eventTzOffsetMs(now);
  // The venue's wall clock for `now`, expressed on the UTC calendar, with the
  // requested time placed on it - then shifted back to a real instant.
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - offsetMs);
}

/**
 * The real instant of "HH:MM" IN THE VENUE TIMEZONE on the venue calendar day
 * `day` (a UTC-midnight date-only value, as Session.startDate stores). The
 * offset is sampled at that day's noon so a DST switch at midnight cannot
 * skew it.
 */
export function eventTimeOnDay(day, timeString) {
  const [hour, minute] = timeString.split(":").map(Number);
  const base = utcDayStart(day);
  const offsetMs = eventTzOffsetMs(
    new Date(base.getTime() + 12 * 60 * 60 * 1000)
  );
  const local = new Date(base);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - offsetMs);
}

/**
 * The venue calendar day of `instant` as a "YYYY-MM-DD" key - the one way
 * dashboards and reports bucket rows into days. Server-local
 * format(date, "yyyy-MM-dd") disagrees with the check-in path's venue-day
 * discipline whenever host and venue timezones differ.
 */
export function eventDayKey(instant) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ENV.EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * The [start, end] instants of the venue calendar day(s) named by date-only
 * inputs, for check-in time range filters: `start` is 00:00 venue time on
 * startDate's calendar day, `end` is the last millisecond of endDate's.
 * Either bound may be omitted.
 */
export function eventDayRange(startDate, endDate) {
  const range = {};
  if (startDate) {
    range.start = eventTimeOnDay(utcDayStart(startDate), "00:00");
  }
  if (endDate) {
    const nextDay = addUtcDays(utcDayStart(endDate), 1);
    range.end = new Date(eventTimeOnDay(nextDay, "00:00").getTime() - 1);
  }
  return range;
}
