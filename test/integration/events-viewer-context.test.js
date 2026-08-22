// test/integration/events-viewer-context.test.js
//
// The events read surfaces: attendant viewers get currentSession +
// viewerAttendance attached (batched server-side, so the client's event grid
// needs zero per-card attendance requests), admins get the bare event, and
// archived events are hidden from attendants. Plus the list/read/delete
// basics.
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";
import {
  adminCookie,
  attendantCookie,
  createAdmin,
  createAttendant,
  createEventWithActiveSession,
} from "../helpers.js";

describe("GET /api/v1/events (viewer context)", () => {
  it("attaches currentSession and viewerAttendance for an attendant", async () => {
    const user = await createAttendant({ email: "vc1@test.local" });
    const { event, session } = await createEventWithActiveSession();
    await prisma.attendance.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        status: "PRESENT",
        checkInTime: new Date(),
      },
    });

    const res = await request(app)
      .get("/api/v1/events")
      .set("Cookie", [attendantCookie(user)]);

    expect(res.status).toBe(200);
    const row = res.body.data.find((e) => e.id === event.id);
    expect(row.currentSession).toMatchObject({ id: session.id });
    expect(row.viewerAttendance).toMatchObject({
      sessionId: session.id,
      status: "PRESENT",
      autoCheckedOut: false,
    });
    expect(row.viewerAttendance.checkInTime).toBeTruthy();
    expect(row.viewerAttendance.checkOutTime).toBeNull();
  });

  it("returns null context when the attendant has not checked in / no session today", async () => {
    const user = await createAttendant({ email: "vc2@test.local" });
    const { event } = await createEventWithActiveSession();

    const res = await request(app)
      .get("/api/v1/events")
      .set("Cookie", [attendantCookie(user)]);

    const row = res.body.data.find((e) => e.id === event.id);
    expect(row.currentSession).not.toBeUndefined();
    expect(row.viewerAttendance).toBeNull();
  });

  it("omits the viewer context for admins", async () => {
    const admin = await createAdmin({ email: "vc3@test.local" });
    await createEventWithActiveSession();

    const res = await request(app)
      .get("/api/v1/events")
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.currentSession).toBeUndefined();
      expect(row.viewerAttendance).toBeUndefined();
    }
  });

  it("hides archived events from attendants but not admins", async () => {
    const user = await createAttendant({ email: "vc4@test.local" });
    const admin = await createAdmin({ email: "vc4-admin@test.local" });
    const { event } = await createEventWithActiveSession();
    await prisma.event.update({
      where: { id: event.id },
      data: { archived: true },
    });

    const forUser = await request(app)
      .get("/api/v1/events")
      .set("Cookie", [attendantCookie(user)]);
    expect(forUser.body.data ?? []).not.toContainEqual(
      expect.objectContaining({ id: event.id })
    );

    const forAdmin = await request(app)
      .get("/api/v1/events")
      .set("Cookie", [adminCookie(admin)]);
    expect(
      forAdmin.body.data.some((e) => e.id === event.id)
    ).toBe(true);
  });
});

describe("GET /api/v1/events/:eventId", () => {
  it("returns the event with viewer context for an attendant", async () => {
    const user = await createAttendant({ email: "vc5@test.local" });
    const { event, session } = await createEventWithActiveSession();

    const res = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Cookie", [attendantCookie(user)]);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(event.id);
    expect(res.body.data.currentSession).toMatchObject({ id: session.id });
    expect(res.body.data.viewerAttendance).toBeNull();
    // The secret never leaves the server.
    expect(res.body.data.venueSecret).toBeUndefined();
  });

  it("404s for an unknown or soft-deleted event", async () => {
    const admin = await createAdmin({ email: "vc6@test.local" });
    const { event } = await createEventWithActiveSession();
    await prisma.event.update({
      where: { id: event.id },
      data: { deletedAt: new Date() },
    });

    const gone = await request(app)
      .get(`/api/v1/events/${event.id}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(gone.status).toBe(404);

    const unknown = await request(app)
      .get("/api/v1/events/999999")
      .set("Cookie", [adminCookie(admin)]);
    expect(unknown.status).toBe(404);
  });
});

describe("DELETE /api/v1/events/:eventId", () => {
  it("soft-deletes an event without attendance", async () => {
    const admin = await createAdmin({ email: "vc7@test.local" });
    const { event } = await createEventWithActiveSession();

    const res = await request(app)
      .delete(`/api/v1/events/${event.id}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(res.status).toBe(200);

    // Soft-deleted: gone from the API, still in the table.
    const row = await prisma.event.findUnique({ where: { id: event.id } });
    expect(row.deletedAt).toBeTruthy();
  });

  it("refuses to delete an event with attendance history", async () => {
    const admin = await createAdmin({ email: "vc8@test.local" });
    const user = await createAttendant({ email: "vc8-user@test.local" });
    const { event, session } = await createEventWithActiveSession();
    await prisma.attendance.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        status: "PRESENT",
        checkInTime: new Date(),
      },
    });

    const res = await request(app)
      .delete(`/api/v1/events/${event.id}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/archive/i);

    expect(
      (await prisma.event.findUnique({ where: { id: event.id } })).deletedAt
    ).toBeNull();
  });

  it("is admin-only", async () => {
    const user = await createAttendant({ email: "vc9@test.local" });
    const { event } = await createEventWithActiveSession();

    const res = await request(app)
      .delete(`/api/v1/events/${event.id}`)
      .set("Cookie", [attendantCookie(user)]);
    expect(res.status).toBe(403);
  });
});
