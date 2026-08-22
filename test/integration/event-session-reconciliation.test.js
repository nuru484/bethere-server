// test/integration/event-session-reconciliation.test.js
//
// Schedule edits on an event with no attendance rebuild its sessions: the
// old rows are deleted with the update and the worker recreates them from
// the new shape. Without the rebuild, moving an event's date strands it -
// check-in stays open on the old days and closed on the new ones.
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";
import { processSessionJob } from "../../src/jobs/session-worker.js";
import { addUtcDays, eventCalendarDay, utcDayAtTime } from "../../src/utils/time-context.js";
import { adminCookie, createAdmin, createAttendant } from "../helpers.js";

async function createEventWithSession({
  day,
  endDay = day,
  startTime = "09:00",
  endTime = "17:00",
}) {
  const location = await prisma.location.create({ data: { name: "Hall A" } });
  const event = await prisma.event.create({
    data: {
      title: "Reconcile Event",
      startDate: day,
      endDate: endDay,
      isRecurring: false,
      startTime,
      endTime,
      locationId: location.id,
      type: "MEETING",
    },
  });
  const session = await prisma.session.create({
    data: {
      eventId: event.id,
      startDate: day,
      endDate: day,
      startTime: utcDayAtTime(day, startTime),
      endTime: utcDayAtTime(day, endTime),
    },
  });
  return { event, session };
}

const updateEvent = (admin, eventId, body) =>
  request(app)
    .put(`/api/v1/events/${eventId}`)
    .set("Cookie", [adminCookie(admin)])
    .send(body);

describe("event update session reconciliation", () => {
  it("moving a one-off event to another date deletes the old session and rebuilds on the new date", async () => {
    const admin = await createAdmin({ email: "rec1@test.local" });
    const oldDay = addUtcDays(eventCalendarDay(), 10);
    const newDay = addUtcDays(eventCalendarDay(), 3);
    const { event, session } = await createEventWithSession({ day: oldDay });

    const res = await updateEvent(admin, event.id, {
      startDate: newDay.toISOString(),
      endDate: newDay.toISOString(),
    });
    expect(res.status).toBe(200);

    // Old-date session gone immediately (same transaction as the update).
    expect(
      await prisma.session.findUnique({ where: { id: session.id } })
    ).toBeNull();

    // The queued rebuild (driven directly here - tests run no workers)
    // creates the new-date session from the fresh event shape.
    const result = await processSessionJob({ data: { eventId: event.id } });
    expect(result.status).toBe("success");

    const sessions = await prisma.session.findMany({
      where: { eventId: event.id },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startDate.toISOString()).toBe(newDay.toISOString());
  });

  it("changing the daily times rebuilds sessions with the new times", async () => {
    const admin = await createAdmin({ email: "rec2@test.local" });
    const day = addUtcDays(eventCalendarDay(), 5);
    const { event } = await createEventWithSession({ day });

    const res = await updateEvent(admin, event.id, {
      startTime: "13:00",
      endTime: "15:30",
    });
    expect(res.status).toBe(200);

    expect(
      await prisma.session.count({ where: { eventId: event.id } })
    ).toBe(0);

    await processSessionJob({ data: { eventId: event.id } });

    const rebuilt = await prisma.session.findFirst({
      where: { eventId: event.id },
    });
    expect(rebuilt.startTime.toISOString()).toBe(
      utcDayAtTime(day, "13:00").toISOString()
    );
    expect(rebuilt.endTime.toISOString()).toBe(
      utcDayAtTime(day, "15:30").toISOString()
    );
  });

  it("leaves sessions alone when the event has attendance", async () => {
    const admin = await createAdmin({ email: "rec3@test.local" });
    const user = await createAttendant({ email: "rec3-user@test.local" });
    // endDay tomorrow so the one-off event has not "passed" (that rule
    // blocks edits on finished non-recurring events).
    const day = eventCalendarDay();
    const { event, session } = await createEventWithSession({
      day,
      endDay: addUtcDays(day, 1),
    });
    await prisma.attendance.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        status: "PRESENT",
        checkInTime: new Date(),
      },
    });

    // Time edits are allowed with attendance; the session rows must survive.
    const res = await updateEvent(admin, event.id, { endTime: "23:00" });
    expect(res.status).toBe(200);

    expect(
      await prisma.session.findUnique({ where: { id: session.id } })
    ).toBeTruthy();
    expect(
      await prisma.attendance.count({ where: { sessionId: session.id } })
    ).toBe(1);
  });

  it("rejects an inverted daily window on the merged values", async () => {
    const admin = await createAdmin({ email: "rec4@test.local" });
    const day = addUtcDays(eventCalendarDay(), 5);
    const { event } = await createEventWithSession({ day });

    // endTime before the EXISTING startTime: only the merged check sees it.
    const res = await updateEvent(admin, event.id, { endTime: "08:00" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/endTime must be after startTime/i);
  });

  it("rejects an inverted date range", async () => {
    const admin = await createAdmin({ email: "rec5@test.local" });
    const day = addUtcDays(eventCalendarDay(), 5);
    const { event } = await createEventWithSession({ day });

    const res = await updateEvent(admin, event.id, {
      endDate: addUtcDays(day, -2).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/endDate must be on or after startDate/i);
  });
});
