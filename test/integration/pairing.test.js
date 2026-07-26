// test/integration/pairing.test.js
//
// The cross-device "scan from phone" hand-off through the real app. Liveness is
// disabled here (LIVENESS_ENABLED=false), so these exercise the pairing
// lifecycle: a laptop starts a pairing, the phone authenticates ONLY with the
// hand-off token, completes the scan via the reused step services, and the
// laptop's poll sees COMPLETED.
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import {
  attendantCookie,
  createEventWithActiveSession,
  createAttendant,
  venueCodeFor,
  DESCRIPTOR,
} from "../helpers.js";

const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const enrolled = (email) => createAttendant({ email, faceScan: DESCRIPTOR });

const startPairing = (user, body) =>
  request(app)
    .post("/api/v1/pairing")
    .set("Cookie", [attendantCookie(user)])
    .send(body);

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe("pairing (scan from phone)", () => {
  it("runs a full check-in on the phone and the laptop poll sees it complete", async () => {
    const user = await enrolled("pair-ci@test.local");
    const { event } = await createEventWithActiveSession();
    const venueCode = venueCodeFor(event.venueSecret);

    // Laptop starts the pairing.
    const start = await startPairing(user, {
      scope: "ATTENDANCE",
      eventId: event.id,
      mode: "in",
    });
    expect(start.status).toBe(201);
    const { pairingId, handoffToken } = start.body.data;
    expect(pairingId).toBeTruthy();
    expect(typeof handoffToken).toBe("string");

    // Phone reads what it is authorized to capture.
    const context = await request(app)
      .get("/api/v1/pairing/session/context")
      .set(bearer(handoffToken));
    expect(context.status).toBe(200);
    expect(context.body.data.scope).toBe("ATTENDANCE");
    expect(context.body.data.eventId).toBe(event.id);
    expect(context.body.data.mode).toBe("in");

    // Phone runs the step flow with ONLY the hand-off token.
    const ch = await request(app)
      .post("/api/v1/pairing/session/step-challenge")
      .set(bearer(handoffToken))
      .send({ venueCode });
    expect(ch.status).toBe(200);
    const { challengeToken, totalSteps } = ch.body.data;

    let last;
    for (let i = 0; i < totalSteps; i++) {
      const req = request(app)
        .post("/api/v1/pairing/session/step")
        .set(bearer(handoffToken))
        .field("challengeToken", challengeToken)
        .field("venueCode", venueCode);
      for (let f = 0; f < 6; f++) req.attach("frames", FRAME, `f-${f}.jpg`);
      last = await req;
    }
    expect(last.status).toBe(200);
    expect(last.body.data.done).toBe(true);
    expect(last.body.data.attendance.status).toMatch(/PRESENT|LATE/);

    // Laptop poll now reports completion.
    const poll = await request(app)
      .get(`/api/v1/pairing/${pairingId}`)
      .set("Cookie", [attendantCookie(user)]);
    expect(poll.status).toBe(200);
    expect(poll.body.data.status).toBe("COMPLETED");
  });

  it("rejects a phone request with no hand-off token", async () => {
    const res = await request(app).get("/api/v1/pairing/session/context");
    expect(res.status).toBe(401);
  });

  it("rejects a phone request with a bogus hand-off token", async () => {
    const res = await request(app)
      .get("/api/v1/pairing/session/context")
      .set(bearer("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  it("does not let a hand-off token, once its pairing completes, start again", async () => {
    const user = await enrolled("pair-reuse@test.local");
    const { event } = await createEventWithActiveSession();
    const venueCode = venueCodeFor(event.venueSecret);

    const start = await startPairing(user, {
      scope: "ATTENDANCE",
      eventId: event.id,
      mode: "in",
    });
    const { handoffToken } = start.body.data;

    const ch = await request(app)
      .post("/api/v1/pairing/session/step-challenge")
      .set(bearer(handoffToken))
      .send({ venueCode });
    for (let i = 0; i < ch.body.data.totalSteps; i++) {
      const req = request(app)
        .post("/api/v1/pairing/session/step")
        .set(bearer(handoffToken))
        .field("challengeToken", ch.body.data.challengeToken)
        .field("venueCode", venueCode);
      for (let f = 0; f < 6; f++) req.attach("frames", FRAME, `f-${f}.jpg`);
      await req;
    }

    // Pairing is COMPLETED; the same token can no longer start a new scan.
    const again = await request(app)
      .post("/api/v1/pairing/session/step-challenge")
      .set(bearer(handoffToken))
      .send({ venueCode });
    expect(again.status).toBe(401);
  });

  it("forbids polling a pairing that belongs to another user", async () => {
    const owner = await enrolled("pair-owner@test.local");
    const other = await enrolled("pair-other@test.local");
    const { event } = await createEventWithActiveSession();

    const start = await startPairing(owner, {
      scope: "ATTENDANCE",
      eventId: event.id,
      mode: "in",
    });
    const res = await request(app)
      .get(`/api/v1/pairing/${start.body.data.pairingId}`)
      .set("Cookie", [attendantCookie(other)]);
    expect(res.status).toBe(403);
  });

  it("runs a full enrollment on the phone", async () => {
    const user = await createAttendant({ email: "pair-enroll@test.local" });

    const start = await startPairing(user, { scope: "ENROLL" });
    expect(start.status).toBe(201);
    const { handoffToken } = start.body.data;

    const ch = await request(app)
      .post("/api/v1/pairing/session/step-challenge")
      .set(bearer(handoffToken))
      .send({});
    expect(ch.status).toBe(200);

    let last;
    for (let i = 0; i < ch.body.data.totalSteps; i++) {
      const req = request(app)
        .post("/api/v1/pairing/session/step")
        .set(bearer(handoffToken))
        .field("challengeToken", ch.body.data.challengeToken)
        .field("consent", "true");
      for (let f = 0; f < 6; f++) req.attach("frames", FRAME, `f-${f}.jpg`);
      last = await req;
    }
    expect(last.status).toBe(200);
    expect(last.body.data.done).toBe(true);
    expect(last.body.data.user.hasFaceScan).toBe(true);
  });

  it("requires an eventId to pair a check-in", async () => {
    const user = await enrolled("pair-noevent@test.local");
    const res = await startPairing(user, { scope: "ATTENDANCE", mode: "in" });
    expect(res.status).toBe(400);
  });

  it("runs a full check-in on the phone via the batch flow (one upload)", async () => {
    const user = await enrolled("pair-batch-ci@test.local");
    const { event } = await createEventWithActiveSession();
    const venueCode = venueCodeFor(event.venueSecret);

    const start = await startPairing(user, {
      scope: "ATTENDANCE",
      eventId: event.id,
      mode: "in",
    });
    const { pairingId, handoffToken } = start.body.data;

    // Phone mints a batch challenge (all actions up-front, prompted locally).
    const ch = await request(app)
      .post("/api/v1/pairing/session/challenge")
      .set(bearer(handoffToken))
      .send({ venueCode });
    expect(ch.status).toBe(200);
    expect(Array.isArray(ch.body.data.actions)).toBe(true);
    expect(ch.body.data.actions.length).toBeGreaterThan(0);
    expect(typeof ch.body.data.challengeToken).toBe("string");

    // One burst proving everything.
    const submit = request(app)
      .post("/api/v1/pairing/session/capture")
      .set(bearer(handoffToken))
      .field("challengeToken", ch.body.data.challengeToken)
      .field("venueCode", venueCode);
    for (let f = 0; f < 8; f++) submit.attach("frames", FRAME, `f-${f}.jpg`);
    const done = await submit;
    expect(done.status).toBe(200);
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.attendance.status).toMatch(/PRESENT|LATE/);

    const poll = await request(app)
      .get(`/api/v1/pairing/${pairingId}`)
      .set("Cookie", [attendantCookie(user)]);
    expect(poll.body.data.status).toBe("COMPLETED");
  });

  it("runs a full enrollment on the phone via the batch flow", async () => {
    const user = await createAttendant({ email: "pair-batch-enroll@test.local" });

    const start = await startPairing(user, { scope: "ENROLL" });
    const { handoffToken } = start.body.data;

    const ch = await request(app)
      .post("/api/v1/pairing/session/challenge")
      .set(bearer(handoffToken))
      .send({});
    expect(ch.status).toBe(200);

    const submit = request(app)
      .post("/api/v1/pairing/session/capture")
      .set(bearer(handoffToken))
      .field("challengeToken", ch.body.data.challengeToken)
      .field("consent", "true");
    for (let f = 0; f < 8; f++) submit.attach("frames", FRAME, `f-${f}.jpg`);
    const done = await submit;
    expect(done.status).toBe(200);
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.user.hasFaceScan).toBe(true);
  });

  it("rejects a batch capture with too few frames without consuming the pairing", async () => {
    const user = await enrolled("pair-batch-frames@test.local");
    const { event } = await createEventWithActiveSession();
    const venueCode = venueCodeFor(event.venueSecret);

    const start = await startPairing(user, {
      scope: "ATTENDANCE",
      eventId: event.id,
      mode: "in",
    });
    const { pairingId, handoffToken } = start.body.data;

    const ch = await request(app)
      .post("/api/v1/pairing/session/challenge")
      .set(bearer(handoffToken))
      .send({ venueCode });

    const submit = request(app)
      .post("/api/v1/pairing/session/capture")
      .set(bearer(handoffToken))
      .field("challengeToken", ch.body.data.challengeToken)
      .field("venueCode", venueCode);
    for (let f = 0; f < 3; f++) submit.attach("frames", FRAME, `f-${f}.jpg`);
    const res = await submit;
    expect(res.status).toBe(400);

    // The pairing is still PENDING - the phone can retry.
    const poll = await request(app)
      .get(`/api/v1/pairing/${pairingId}`)
      .set("Cookie", [attendantCookie(user)]);
    expect(poll.body.data.status).toBe("PENDING");
  });
});
