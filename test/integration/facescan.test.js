// test/integration/facescan.test.js
//
// Face enrollment over HTTP. Enrollment is SERVER-SIDE: the client uploads
// frames and the server derives the template, so there is no way to post a
// descriptor computed in the browser (or built from a photo of someone else).
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";
import { setEnrollmentVerifierForTest } from "../../src/services/liveness/liveness-verifier.js";
import {
  adminCookie,
  attendantCookie,
  createAdmin,
  createAttendant,
  DESCRIPTOR,
} from "../helpers.js";

const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** Forces the enrollment verdict without loading the ML models. */
const stubEnroller = (verdict) =>
  setEnrollmentVerifierForTest({ enroll: async () => verdict });

const PASSING = {
  passed: true,
  reasons: [],
  failedActions: [],
  descriptor: DESCRIPTOR,
};

afterEach(() => setEnrollmentVerifierForTest(null));

/** Runs step 1 and returns the challenge token. */
async function getChallenge(cookie) {
  const res = await request(app)
    .post("/api/v1/facescan/challenge")
    .set("Cookie", cookie)
    .expect(200);
  return res.body.data.challengeToken;
}

/** Attaches the minimum number of frames a capture must carry. */
function withFrames(req, count = 6) {
  for (let i = 0; i < count; i++) {
    req.attach("frames", FRAME, `frame-${i}.jpg`);
  }
  return req;
}

describe("POST /api/v1/facescan (server-side enrollment)", () => {
  it("derives the template from uploaded frames and returns the refreshed user", async () => {
    const user = await createAttendant({ email: "enroll@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    const token = await getChallenge(cookie);
    const res = await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
    );

    expect(res.status).toBe(200);
    expect(res.body.data.user.hasFaceScan).toBe(true);
    // The template never leaves the server, in either direction.
    expect(res.body.data.user.faceScan).toBeUndefined();
    expect(res.body.data.user.faceScanEnc).toBeUndefined();

    // It is stored ENCRYPTED, never as the raw column.
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored.faceScanEnc).toBeTruthy();
    expect(stored.faceScan).toBeNull();
    expect(stored.biometricConsentAt).toBeTruthy();
  });

  it("ignores any descriptor the client tries to supply", async () => {
    const user = await createAttendant({ email: "nodesc@test.local" });
    const cookie = attendantCookie(user);
    // The server derives THIS descriptor; the client will try to post another.
    stubEnroller(PASSING);

    const token = await getChallenge(cookie);
    const forged = DESCRIPTOR.map((n) => n + 0.5);

    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
        .field("faceScan", JSON.stringify(forged))
    ).expect(200);

    // What got stored is the server's descriptor, not the posted one.
    const { decryptTemplate } = await import(
      "../../src/utils/biometric-crypto.js"
    );
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    // v2 ciphertext is owner-bound: decrypting requires the owning user id.
    const template = decryptTemplate(stored.faceScanEnc, { userId: user.id });
    expect(template[0]).toBeCloseTo(DESCRIPTOR[0], 5);
    expect(template[0]).not.toBeCloseTo(forged[0], 5);
  });

  it("refuses a capture the server cannot verify as live", async () => {
    const user = await createAttendant({ email: "notlive@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller({
      passed: false,
      reasons: ["action_not_satisfied"],
      failedActions: ["BLINK"],
      descriptor: null,
    });

    const token = await getChallenge(cookie);
    const res = await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
    );

    expect(res.status).toBe(400);
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored.faceScanEnc).toBeNull();
  });

  it("requires a challenge, and burns it after one use", async () => {
    const user = await createAttendant({ email: "once@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    // No challenge at all.
    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("consent", "true")
    ).expect(400);

    const token = await getChallenge(cookie);
    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
    ).expect(200);

    // Reset so the "already enrolled" guard cannot mask the replay check.
    const admin = await createAdmin({ email: "reset1@test.local" });
    await request(app)
      .delete(`/api/v1/facescan/${user.id}`)
      .set("Cookie", adminCookie(admin))
      .expect(200);

    const replay = await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
    );
    expect(replay.status).toBe(401);
  });

  it("refuses enrollment without consent", async () => {
    const user = await createAttendant({ email: "noconsent@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    const token = await getChallenge(cookie);
    const res = await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "false")
    );

    expect(res.status).toBe(400);
  });

  it("rejects a capture with too few frames", async () => {
    const user = await createAttendant({ email: "fewframes@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    const token = await getChallenge(cookie);
    const res = await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true"),
      2
    );

    expect(res.status).toBe(400);
  });

  it("blocks a second enrollment until an admin resets it", async () => {
    const user = await createAttendant({ email: "reenroll@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    const first = await getChallenge(cookie);
    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", first)
        .field("consent", "true")
    ).expect(200);

    // Step 1 itself refuses once a template is on file.
    await request(app)
      .post("/api/v1/facescan/challenge")
      .set("Cookie", cookie)
      .expect(409);

    const admin = await createAdmin({ email: "reset2@test.local" });
    await request(app)
      .delete(`/api/v1/facescan/${user.id}`)
      .set("Cookie", adminCookie(admin))
      .expect(200);

    const second = await getChallenge(cookie);
    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", second)
        .field("consent", "true")
    ).expect(200);
  });

  it("only lets admins reset another user's face scan", async () => {
    const user = await createAttendant({ email: "victim@test.local" });
    const cookie = attendantCookie(user);
    stubEnroller(PASSING);

    const token = await getChallenge(cookie);
    await withFrames(
      request(app)
        .post("/api/v1/facescan")
        .set("Cookie", cookie)
        .field("challengeToken", token)
        .field("consent", "true")
    ).expect(200);

    const other = await createAttendant({ email: "other@test.local" });
    await request(app)
      .delete(`/api/v1/facescan/${user.id}`)
      .set("Cookie", attendantCookie(other))
      .expect(403);
  });
});
