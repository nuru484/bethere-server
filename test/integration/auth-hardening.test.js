// test/integration/auth-hardening.test.js
//
// Deliberate token-type rejection, OTP attempt-cap lockout, challenge TTL
// expiry, refresh-token absolute expiry, and the 2FA disable flow. Delivery
// senders are mocked at the module seam (same pattern as auth-flows) so the
// tests can read the code that "went out".
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const sent = { sms: [], mail: [] };

vi.mock("../../src/utils/send-sms.js", () => ({
  sendSms: vi.fn(async (phone, message) => {
    sent.sms.push({ phone, message });
  }),
}));
vi.mock("../../src/utils/send-mail.js", () => ({
  default: vi.fn(async ({ email, text }) => {
    sent.mail.push({ email, text });
  }),
}));
vi.mock("../../src/jobs/mail-queue.js", () => ({
  // Queued mail lands in the same outbox as the direct sends: a test asking
  // "was this person told?" should not have to care which side of the queue
  // the message went out on.
  enqueueEmail: vi.fn(async (options) => {
    sent.mail.push({ email: options.email, text: options.text });
  }),
  mailQueue: { add: vi.fn(), close: vi.fn() },
}));

const { default: app } = await import("../../app.js");
const { prisma } = await import("../../src/config/prisma-client.js");
const { default: ENV } = await import("../../src/config/env.js");
const { attendantCookie, createAttendant, sessionFor, cookiesFromResponse } =
  await import("../helpers.js");
const { COOKIE_NAMES } = await import("../../src/utils/cookie-manager.js");

const lastCode = () => {
  const all = [...sent.sms.map((s) => s.message), ...sent.mail.map((m) => m.text)];
  const match = all[all.length - 1]?.match(/\b(\d{6})\b/);
  return match?.[1];
};

beforeEach(() => {
  sent.sms.length = 0;
  sent.mail.length = 0;
});

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

describe("access-token type check", () => {
  it("rejects a pending-2FA token used as an access token, by design", async () => {
    const user = await createAttendant({ email: "typ1@test.local" });

    // Exactly what loginWithPassword mints for the 2FA pending step - same
    // secret as access tokens, but purpose-tagged. Even with a tv claim
    // grafted on, so that nothing else about its shape gives it away, the
    // explicit purpose check must refuse it.
    const pending = jwt.sign(
      { id: user.id, kind: "USER", purpose: "2FA_PENDING", tv: 0, role: "USER" },
      ENV.ACCESS_TOKEN_SECRET,
      { expiresIn: "5m" }
    );

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", [`${COOKIE_NAMES.access}=${pending}`]);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });

  it("still accepts a legacy access token without the typ claim", async () => {
    const user = await createAttendant({ email: "typ2@test.local" });

    // attendantCookie signs without typ (the pre-migration shape).
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", [attendantCookie(user)]);

    expect(res.status).toBe(200);
  });
});

describe("OTP attempt cap", () => {
  it("locks the code after 5 wrong attempts; the right code no longer works", async () => {
    const user = await createAttendant({
      email: "otp-cap@test.local",
      phone: "+233540000031",
    });
    await prisma.otpCode.create({
      data: {
        kind: "USER",
        principalId: user.id,
        purpose: "LOGIN",
        channel: "SMS",
        codeHash: sha256("123456"),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const verify = (code) =>
      request(app)
        .post("/api/v1/auth/otp/verify")
        .send({ identifier: "otp-cap@test.local", code });

    for (let i = 0; i < 5; i++) {
      const res = await verify("000000");
      expect(res.status).toBe(400);
    }

    // Attempts have hit the cap; even the correct code is dead now.
    const res = await verify("123456");
    expect(res.status).toBe(400);

    const row = await prisma.otpCode.findFirst({
      where: { principalId: user.id },
    });
    expect(row.attempts).toBe(5);
    expect(row.consumedAt).toBeTruthy();
  });
});

describe("liveness challenge TTL", () => {
  it("rejects an expired challenge token with CHALLENGE_EXPIRED", async () => {
    const user = await createAttendant({ email: "ttl@test.local" });

    // A structurally valid enrollment challenge token that has already
    // expired: jwt.verify fails on exp, which is the TTL gate.
    const expired = jwt.sign(
      {
        userId: user.id,
        eventId: null,
        nonce: crypto.randomUUID(),
        mode: "enroll",
        purpose: "LIVENESS_CHALLENGE",
      },
      ENV.ACCESS_TOKEN_SECRET,
      { expiresIn: -10 }
    );

    const req = request(app)
      .post("/api/v1/facescan")
      .set("Cookie", [attendantCookie(user)])
      .field("challengeToken", expired)
      .field("consent", "true");
    const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    for (let i = 0; i < 6; i++) req.attach("frames", FRAME, `f${i}.jpg`);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("CHALLENGE_EXPIRED");
  });
});

describe("refresh token absolute expiry", () => {
  it("refuses rotation once the stored row has expired", async () => {
    const user = await createAttendant({ email: "refresh-exp@test.local" });
    const { refreshCookie } = await sessionFor("USER", user);

    // Age the row past its absolute expiry; the JWT itself is still valid.
    await prisma.refreshToken.updateMany({
      where: { principalId: user.id, kind: "USER" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/api/v1/refreshToken")
      .set("Cookie", [refreshCookie]);

    expect(res.status).toBe(401);
  });
});

describe("2FA disable flow", () => {
  it("enables then disables 2FA with code proof; login stops requiring a code", async () => {
    const user = await createAttendant({
      email: "tfa-off@test.local",
      phone: "+233540000032",
    });
    const cookie = [attendantCookie(user)];

    // Enable: challenge sends a code, enable consumes it.
    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .set("Cookie", cookie)
      .expect(200);
    const enable = await request(app)
      .post("/api/v1/auth/2fa/enable")
      .set("Cookie", cookie)
      .send({ code: lastCode() });
    expect(enable.status).toBe(200);
    expect(enable.body.data.user.twoFactorEnabled).toBe(true);

    // Cooldown is per (kind, principal, purpose): clear the outstanding
    // window so the disable challenge can mint a fresh code.
    await prisma.otpCode.deleteMany({});

    await request(app)
      .post("/api/v1/auth/2fa/challenge")
      .set("Cookie", cookie)
      .expect(200);
    const disable = await request(app)
      .post("/api/v1/auth/2fa/disable")
      .set("Cookie", cookie)
      .send({ code: lastCode() });
    expect(disable.status).toBe(200);
    expect(disable.body.data.user.twoFactorEnabled).toBe(false);

    // Login is single-step again: cookies issued, no pending step.
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "tfa-off@test.local", password: "Password123!" });
    expect(login.status).toBe(200);
    expect(login.body.data.twoFactorRequired).toBeUndefined();
    expect(cookiesFromResponse(login).join(";")).toMatch(/bethere/);
  });
});
