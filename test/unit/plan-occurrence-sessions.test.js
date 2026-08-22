// test/unit/plan-occurrence-sessions.test.js
//
// Sessions are stored one row PER DAY. Attendance is unique on
// (userId, sessionId), so a single row spanning a multi-day event would mean
// one check-in for the whole span - a five-day conference recording one day
// per attendee and refusing the rest with "already checked in".
import { describe, expect, it } from "vitest";
import { planOccurrenceSessions } from "../../src/services/session-planning.js";

// UTC midnight: session rows are keyed on a UTC-midnight startDate (see
// utils/time-context.js), and startDate is half of @@unique([eventId,
// startDate]) - an off-midnight value would let the same calendar day exist
// twice for one event.
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

const plan = (over = {}) =>
  planOccurrenceSessions({
    eventId: 1,
    occurrenceStart: day("2026-07-20"),
    durationDays: 1,
    startTime: "09:00",
    endTime: "17:00",
    ...over,
  });

describe("planOccurrenceSessions", () => {
  it("plans a single row for a one-day event", () => {
    const rows = plan();

    expect(rows).toHaveLength(1);
    expect(rows[0].startDate).toEqual(rows[0].endDate);
    expect(rows[0].startTime.getUTCHours()).toBe(9);
    expect(rows[0].endTime.getUTCHours()).toBe(17);
  });

  it("plans one row per day across a multi-day event", () => {
    const rows = plan({ durationDays: 5 });

    expect(rows).toHaveLength(5);
    // Consecutive days, each self-contained so attendance is per day.
    expect(rows.map((r) => r.startDate.getUTCDate())).toEqual([20, 21, 22, 23, 24]);
    rows.forEach((row) => {
      expect(row.startDate).toEqual(row.endDate);
      expect(row.startTime.getUTCHours()).toBe(9);
      expect(row.endTime.getUTCHours()).toBe(17);
    });
  });

  it("carries the daily time window onto every day, not just the first", () => {
    const rows = plan({ durationDays: 3, startTime: "08:30", endTime: "12:45" });

    rows.forEach((row) => {
      expect([row.startTime.getUTCHours(), row.startTime.getUTCMinutes()]).toEqual([
        8, 30,
      ]);
      expect([row.endTime.getUTCHours(), row.endTime.getUTCMinutes()]).toEqual([
        12, 45,
      ]);
    });
  });

  it("never plans past the event's end date", () => {
    const rows = plan({ durationDays: 5, eventEndDate: day("2026-07-22") });

    expect(rows).toHaveLength(3);
    expect(rows.at(-1).startDate.getUTCDate()).toBe(22);
  });

  it("treats a missing or zero duration as a single day", () => {
    expect(plan({ durationDays: 0 })).toHaveLength(1);
    expect(plan({ durationDays: undefined })).toHaveLength(1);
  });

  it("keeps every day at UTC midnight across a local DST transition", () => {
    // date-fns addDays and Date#setHours both walk the SERVER's LOCAL
    // calendar, so on a host in a DST-observing zone an occurrence spanning
    // the transition yields a startDate of 23:00 or 01:00 UTC - a second row
    // for a calendar day that already has one.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York"; // DST starts 2026-03-08
    try {
      const rows = planOccurrenceSessions({
        eventId: 1,
        occurrenceStart: day("2026-03-06"),
        durationDays: 5,
        startTime: "09:00",
        endTime: "17:00",
      });

      expect(rows.map((r) => r.startDate.toISOString())).toEqual([
        "2026-03-06T00:00:00.000Z",
        "2026-03-07T00:00:00.000Z",
        "2026-03-08T00:00:00.000Z",
        "2026-03-09T00:00:00.000Z",
        "2026-03-10T00:00:00.000Z",
      ]);
      rows.forEach((row) => {
        expect(row.startTime.getUTCHours()).toBe(9);
        expect(row.endTime.getUTCHours()).toBe(17);
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

