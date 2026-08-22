// test/unit/session-planning.test.js
//
// The shared occurrence arithmetic. Three call sites (worker, daily sweep,
// event update) hand-rolling this math disagree: adding the interval to the
// LAST stored day of a multi-day occurrence without stepping back to its
// first day, and requiring an EXACT date match to enqueue, leaves a multi-day
// recurring event whose worker chain was lost without another session. These
// tests pin the one correct convention.
import { describe, expect, it } from "vitest";
import {
  dueSessionCreation,
  nextOccurrenceStart,
} from "../../src/services/session-planning.js";

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

describe("nextOccurrenceStart", () => {
  it("adds the interval to the last day for a single-day event", () => {
    const next = nextOccurrenceStart(day("2026-07-20"), {
      durationDays: 1,
      recurrenceInterval: 7,
    });

    expect(next).toEqual(day("2026-07-27"));
  });

  it("steps back to the occurrence start for a multi-day event", () => {
    // A 3-day occurrence running Jul 20-22: the newest stored row is the 22nd,
    // but weekly recurrence counts from the 20th - so the 27th, not the 29th.
    const next = nextOccurrenceStart(day("2026-07-22"), {
      durationDays: 3,
      recurrenceInterval: 7,
    });

    expect(next).toEqual(day("2026-07-27"));
  });

  it("handles an interval shorter than the occurrence length", () => {
    // Boundary: interval 3 on a 3-day occurrence packs occurrences
    // back-to-back with no gap.
    const next = nextOccurrenceStart(day("2026-07-22"), {
      durationDays: 3,
      recurrenceInterval: 3,
    });

    expect(next).toEqual(day("2026-07-23"));
  });

  it("never lands on a day the occurrence already covers", () => {
    // A legacy interval SHORTER than the occurrence (2 < 3) lands on Jul 22 -
    // a day that already has a row. The worker then answers "skipped" before
    // it can chain the next job, so the chain dies and the daily sweep
    // re-enqueues the same stalled event forever without ever producing a
    // second occurrence. The next start is always after the last stored day.
    const next = nextOccurrenceStart(day("2026-07-22"), {
      durationDays: 3,
      recurrenceInterval: 2,
    });

    expect(next).toEqual(day("2026-07-23"));
  });

  it("keeps a stalled legacy config moving forward day by day", () => {
    // Feed the result back in, as the worker's chain does: each pass advances.
    const first = nextOccurrenceStart(day("2026-07-22"), {
      durationDays: 5,
      recurrenceInterval: 1,
    });
    const second = nextOccurrenceStart(first, {
      durationDays: 5,
      recurrenceInterval: 1,
    });

    expect(first).toEqual(day("2026-07-23"));
    expect(second).toEqual(day("2026-07-24"));
  });

  it("treats a missing or zero duration as a single day", () => {
    const args = { durationDays: 0, recurrenceInterval: 2 };
    expect(nextOccurrenceStart(day("2026-07-20"), args)).toEqual(
      day("2026-07-22")
    );
    expect(
      nextOccurrenceStart(day("2026-07-20"), {
        durationDays: undefined,
        recurrenceInterval: 2,
      })
    ).toEqual(day("2026-07-22"));
  });

  it("normalizes a timestamp with a time-of-day to the UTC day start", () => {
    const next = nextOccurrenceStart(new Date("2026-07-22T15:45:30.000Z"), {
      durationDays: 3,
      recurrenceInterval: 7,
    });

    expect(next).toEqual(day("2026-07-27"));
  });
});

describe("dueSessionCreation", () => {
  const tomorrow = day("2026-07-27");

  const recurringEvent = (over = {}) => ({
    isRecurring: true,
    startDate: day("2026-07-06"),
    endDate: null,
    durationDays: 3,
    recurrenceInterval: 7,
    lastSessionStartDate: day("2026-07-22"),
    ...over,
  });

  it("targets the event's own start when no session ever materialized", () => {
    const due = dueSessionCreation(
      recurringEvent({ lastSessionStartDate: null, startDate: tomorrow }),
      tomorrow
    );

    expect(due).toEqual({ targetDate: day("2026-07-27"), pastDue: false });
  });

  it("catches up a first occurrence that slipped into the past", () => {
    // A sweep requiring target === tomorrow exactly can never fire again for a
    // start date already behind it.
    const due = dueSessionCreation(
      recurringEvent({
        lastSessionStartDate: null,
        startDate: day("2026-07-01"),
      }),
      tomorrow
    );

    expect(due).toEqual({ targetDate: day("2026-07-01"), pastDue: true });
  });

  it("agrees with the worker for a multi-day recurring event", () => {
    // The divergence the shared module removes: last stored day Jul 22 ends
    // the 3-day occurrence that started Jul 20. The worker targets Jul 27; a
    // sweep computing 22 + 7 = Jul 29 never equals tomorrow (the 27th), so it
    // would never back the worker up.
    const due = dueSessionCreation(recurringEvent(), tomorrow);

    expect(due).toEqual({ targetDate: day("2026-07-27"), pastDue: false });
  });

  it("flags a stalled recurring event as past due", () => {
    // Worker chain lost (Redis flush): the next occurrence is now behind the
    // sweep window and must be enqueued immediately, not date-matched.
    const due = dueSessionCreation(recurringEvent(), day("2026-08-05"));

    expect(due).toEqual({ targetDate: day("2026-07-27"), pastDue: true });
  });

  it("returns null when the next occurrence is not yet due", () => {
    const due = dueSessionCreation(
      recurringEvent({ recurrenceInterval: 14 }),
      tomorrow
    );

    expect(due).toBeNull();
  });

  it("returns null past the event's end date, inclusive on the end day", () => {
    expect(
      dueSessionCreation(recurringEvent({ endDate: day("2026-07-26") }), tomorrow)
    ).toBeNull();
    expect(
      dueSessionCreation(recurringEvent({ endDate: day("2026-07-27") }), tomorrow)
    ).toEqual({ targetDate: day("2026-07-27"), pastDue: false });
  });

  it("makes progress on a legacy interval < duration event instead of spinning", () => {
    // The stall: a target computed onto a day that ALREADY has a row makes
    // the worker skip, the chain die, and every sweep re-enqueue the same date
    // forever with a spurious catch-up warning. The target is the day after
    // the last stored one, and feeding the result back in advances again - the
    // event moves rather than spinning on one date.
    const legacy = { durationDays: 3, recurrenceInterval: 2 };

    const first = dueSessionCreation(
      recurringEvent({ ...legacy, lastSessionStartDate: day("2026-07-22") }),
      tomorrow
    );
    expect(first.targetDate).toEqual(day("2026-07-23"));

    // That occurrence writes Jul 23-25, so the next sweep targets Jul 26.
    const second = dueSessionCreation(
      recurringEvent({ ...legacy, lastSessionStartDate: day("2026-07-25") }),
      tomorrow
    );
    expect(second.targetDate).toEqual(day("2026-07-26"));
  });

  it("returns null for a non-recurring event that already has sessions", () => {
    const due = dueSessionCreation(
      recurringEvent({ isRecurring: false }),
      tomorrow
    );

    expect(due).toBeNull();
  });
});
