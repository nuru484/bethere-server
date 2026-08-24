// test/integration/job-request-id.test.js
//
// Work queued during a request carries that request's correlation id, so a
// job failure in the worker logs can be traced back to the HTTP call that
// caused it.
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { sessionQueue } from "../../src/jobs/session-queue.js";
import { adminCookie, createAdmin } from "../helpers.js";

const futureDate = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

describe("job payload correlation", () => {
  it("stamps the originating requestId on a session job queued by POST /events", async () => {
    const admin = await createAdmin();
    const enqueue = vi.spyOn(sessionQueue, "add").mockResolvedValue({});

    const res = await request(app)
      .post("/api/v1/events")
      .set("Cookie", [adminCookie(admin)])
      .set("X-Request-Id", "req-trace-123")
      .send({
        title: "Traced Event",
        startDate: futureDate(7).toISOString(),
        endDate: futureDate(9).toISOString(),
        startTime: "06:00",
        endTime: "19:30",
        type: "MEETING",
        isRecurring: false,
        location: { name: "Main Hall" },
      });

    expect(res.status).toBe(201);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toMatchObject({
      eventId: res.body.data.id,
      requestId: "req-trace-123",
    });
    enqueue.mockRestore();
  });
});
