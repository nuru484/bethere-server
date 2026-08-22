// test/integration/session-worker.test.js
//
// What the session job refuses to do. A delayed chain job lives in Redis for
// as long as the recurrence interval, so it outlives the change that stopped
// the event. The worker reads the event with findUnique, which the soft-delete
// extension deliberately leaves unscoped, so it must inspect deletedAt and the
// archived flag itself or it will happily create sessions for a stopped event
// and re-chain itself forever.
import { describe, expect, it, vi } from "vitest";

const { prisma } = await import("../../src/config/prisma-client.js");
const { sessionQueue } = await import("../../src/jobs/session-queue.js");
const { processSessionJob } = await import("../../src/jobs/session-worker.js");

const utc = (iso) => new Date(`${iso}T00:00:00.000Z`);

async function createEvent(overrides = {}) {
  const location = await prisma.location.create({ data: { name: "Worker Hall" } });
  return prisma.event.create({
    data: {
      title: "Worker Event",
      startDate: utc("2026-07-20"),
      endDate: null,
      isRecurring: true,
      recurrenceInterval: 7,
      durationDays: 1,
      startTime: "09:00",
      endTime: "17:00",
      locationId: location.id,
      type: "MEETING",
      ...overrides,
    },
  });
}

const runFor = (eventId) => processSessionJob({ data: { eventId } });

describe("session worker job", () => {
  it("creates the occurrence for a live event", async () => {
    const event = await createEvent();

    const result = await runFor(event.id);

    expect(result.status).toBe("success");
    expect(await prisma.session.count({ where: { eventId: event.id } })).toBe(1);
  });

  it("skips a soft-deleted event and does not re-chain", async () => {
    const event = await createEvent({ deletedAt: new Date() });
    const enqueue = vi.spyOn(sessionQueue, "add");

    const result = await runFor(event.id);

    expect(result).toEqual({ status: "skipped", reason: "Event deleted" });
    expect(await prisma.session.count({ where: { eventId: event.id } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it("skips an archived event and does not re-chain", async () => {
    const event = await createEvent({ archived: true });
    const enqueue = vi.spyOn(sessionQueue, "add");

    const result = await runFor(event.id);

    expect(result).toEqual({ status: "skipped", reason: "Event archived" });
    expect(await prisma.session.count({ where: { eventId: event.id } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it("stores every day of a multi-day occurrence at UTC midnight", async () => {
    const event = await createEvent({ durationDays: 3, recurrenceInterval: 7 });

    await runFor(event.id);

    const sessions = await prisma.session.findMany({
      where: { eventId: event.id },
      orderBy: { startDate: "asc" },
    });
    expect(sessions.map((s) => s.startDate.toISOString())).toEqual([
      "2026-07-20T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z",
      "2026-07-22T00:00:00.000Z",
    ]);
  });
});
