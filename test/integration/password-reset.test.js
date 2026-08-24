// test/integration/password-reset.test.js
//
// The full password reset flow through the real app. The mailer is mocked at
// the module seam (same pattern as the OTP tests) so the raw token can be
// read from the email that "went out"; hashing, expiry, single-use, and
// session revocation are all real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

const sent = { mail: [] };

vi.mock("../../src/utils/send-mail.js", () => ({
  default: vi.fn(async (options) => {
    sent.mail.push(options);
  }),
}));
vi.mock("../../src/jobs/mail-queue.js", () => ({
  // Queued mail lands in the same outbox as the direct sends: a test asking
  // "was this person told?" should not have to care which side of the queue
  // the message went out on.
  enqueueEmail: vi.fn(async (options) => {
    sent.mail.push(options);
  }),
  mailQueue: { add: vi.fn(), close: vi.fn() },
}));

const { default: app } = await import("../../app.js");
const { prisma } = await import("../../src/config/prisma-client.js");
const { createAttendant, sessionFor } = await import("../helpers.js");
const { drainDispatches } = await import("../../src/utils/dispatch-async.js");

/**
 * The reset email is dispatched OFF the response path (dispatch-async.js), so
 * it is not guaranteed to have been sent when the request resolves - reading
 * it straight after the response works only if setImmediate happens to fire
 * before supertest's IO callback. Drain the deferred sends instead.
 */
const waitForMail = async () => {
  await drainDispatches();
  return sent.mail;
};

/** The raw token only exists inside the emailed reset link. */
const lastResetToken = async () => {
  const mail = await waitForMail();
  const link = mail.at(-1)?.data?.resetLink ?? "";
  return new URL(link).searchParams.get("token");
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const requestReset = (email) =>
  request(app).post("/api/v1/password-reset/request").send({ email });

const confirmReset = (token, newPassword, confirmPassword = newPassword) =>
  request(app)
    .post("/api/v1/password-reset")
    .send({ token, newPassword, confirmPassword });

// Drain BEFORE clearing, so a send deferred by the previous test cannot land
// in the next test's inbox after the clear.
afterEach(async () => {
  await drainDispatches();
});

beforeEach(() => {
  sent.mail.length = 0;
});

describe("POST /api/v1/password-reset/request", () => {
  it("answers generically for a known email and stores only the token hash", async () => {
    const user = await createAttendant({ email: "reset@test.local" });

    const res = await requestReset("reset@test.local");

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);

    const token = await lastResetToken();
    expect(token).toHaveLength(64);

    const row = await prisma.passwordReset.findFirst({
      where: { kind: "USER", principalId: user.id },
    });
    expect(row).toBeTruthy();
    // Hashed at rest: the raw token exists only in the email.
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.usedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("answers byte-identically for an unknown email and stores nothing", async () => {
    await createAttendant({ email: "reset2@test.local" });

    const known = await requestReset("reset2@test.local");
    const unknown = await requestReset("ghost@test.local");

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.text).toBe(known.text);

    // One email, one row: nothing was created for the unknown address.
    expect(await waitForMail()).toHaveLength(1);
    expect(await prisma.passwordReset.count()).toBe(1);
  });
});

describe("POST /api/v1/password-reset (confirm)", () => {
  it("sets the new password, consumes the token, and revokes sessions", async () => {
    const user = await createAttendant({
      email: "reset3@test.local",
      password: "Password123!",
    });
    const session = await sessionFor("USER", user);

    await requestReset("reset3@test.local");
    const token = await lastResetToken();

    const confirm = await confirmReset(token, "NewPassword456!");
    expect(confirm.status).toBe(200);

    // The new password logs in; the old one is dead.
    const newLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "reset3@test.local", password: "NewPassword456!" });
    expect(newLogin.status).toBe(200);

    const oldLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "reset3@test.local", password: "Password123!" });
    expect(oldLogin.status).toBe(401);

    // Single-use: replaying the same token must fail.
    const replay = await confirmReset(token, "OtherPassword789!");
    expect(replay.status).toBe(400);
    expect(replay.body.message).toMatch(/invalid or expired/i);

    // Every pre-reset session died with the old credential.
    const refresh = await request(app)
      .post("/api/v1/refreshToken")
      .set("Cookie", [session.refreshCookie]);
    expect(refresh.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    await createAttendant({ email: "reset4@test.local" });
    await requestReset("reset4@test.local");
    const token = await lastResetToken();

    await prisma.passwordReset.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await confirmReset(token, "NewPassword456!");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or expired/i);
  });

  it("rejects a weak password via the shared password rules", async () => {
    await createAttendant({ email: "reset5@test.local" });
    await requestReset("reset5@test.local");
    const token = await lastResetToken();

    // No uppercase, no digit: fails the shared policy before the service runs.
    const res = await confirmReset(token, "weakpassword");
    expect(res.status).toBe(400);

    // The token was not consumed by the rejected attempt.
    const row = await prisma.passwordReset.findFirst();
    expect(row.usedAt).toBeNull();
  });
});
