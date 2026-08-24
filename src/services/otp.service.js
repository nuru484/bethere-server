// src/services/otp.service.js
//
// Hashed single-use codes for OTP login and the 2FA second factor. Modeled
// on the password-reset flow: sha256 hash at rest, short TTL, attempt cap,
// atomic consume, resend cooldown. The raw code exists only in the SMS or
// email on its way to the account owner.
import crypto from "node:crypto";
import { prisma } from "../config/prisma-client.js";
import { BadRequestError, TooManyRequestsError } from "../middleware/error-handler.js";
import sendMail from "../utils/send-mail.js";
import { enqueueEmail } from "../jobs/mail-queue.js";
import { sendSms } from "../utils/send-sms.js";
import { dispatchAsync } from "../utils/dispatch-async.js";
import logger from "../utils/logger.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

const generateCode = () => crypto.randomInt(100000, 1000000).toString();

/**
 * Issues a fresh code for (kind, principal, purpose), invalidating any
 * outstanding one, and delivers it phone-first: SMS when the principal has a
 * phone, email otherwise.
 *
 * `channel` pins the delivery channel instead of deriving it from the account
 * (the OTP-login flow answers on the channel the identifier was typed in).
 * `tolerateCooldown` turns the resend cooldown into a no-op that reports the
 * outstanding code's channel rather than a 429 - for callers where a 429 would
 * either abort a half-finished login or leak that the account exists.
 * `deferDelivery` sends the code fire-and-forget after the DB writes, for
 * enumeration-safe callers whose response time must not include a provider
 * round-trip that only happens for real accounts.
 */
export async function issueOtp({
  kind,
  principal,
  purpose,
  channel: requestedChannel,
  tolerateCooldown = false,
  deferDelivery = false,
}) {
  const recent = await prisma.otpCode.findFirst({
    where: {
      kind,
      principalId: principal.id,
      purpose,
      consumedAt: null,
      createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
    },
  });
  if (recent) {
    if (tolerateCooldown) {
      // The outstanding code is still valid; the caller continues with it.
      return { channel: recent.channel, reused: true };
    }
    throw new TooManyRequestsError(
      "A code was just sent. Please wait a minute before requesting another."
    );
  }

  await prisma.otpCode.updateMany({
    where: { kind, principalId: principal.id, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateCode();
  // A pinned SMS channel still needs a phone to send to; fall back to email.
  const wantsSms = requestedChannel
    ? requestedChannel === "SMS"
    : Boolean(principal.phone);
  const channel = wantsSms && principal.phone ? "SMS" : "EMAIL";

  await prisma.otpCode.create({
    data: {
      kind,
      principalId: principal.id,
      purpose,
      channel,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  const label = purpose === "LOGIN" ? "login" : "verification";
  const emailOptions = () => ({
    email: principal.email,
    subject: `Your BeThere ${label} code`,
    text: `Your BeThere ${label} code is ${code}. It expires in 5 minutes.`,
  });
  const send = () =>
    channel === "SMS"
      ? sendSms(
          principal.phone,
          `Your BeThere ${label} code is ${code}. It expires in 5 minutes.`
        )
      : sendMail(emailOptions());

  if (deferDelivery) {
    // DB writes above stay synchronous; only the delivery is deferred. A
    // failure is not surfaced - answering "could not send" only for real
    // accounts would be the same oracle by another route - but an email is
    // handed to the queue rather than dropped, so a refused send is retried
    // instead of leaving someone waiting on a code that never existed.
    if (channel === "EMAIL") {
      dispatchAsync(
        () => enqueueEmail(emailOptions()),
        "OTP email delivery"
      );
    } else {
      dispatchAsync(send, `OTP ${channel} delivery`);
    }
    return { channel, reused: false };
  }

  // Guarded on both channels. An unhandled provider outage here turns OTP and
  // 2FA login into 500s (and high-severity Sentry noise) instead of a
  // retryable message.
  try {
    await send();
  } catch (error) {
    logger.error(
      error,
      channel === "SMS" ? "Failed to send OTP SMS" : "Failed to send OTP email"
    );
    throw new BadRequestError("Could not send the code. Please try again.");
  }

  return { channel, reused: false };
}

/**
 * Verifies and CONSUMES a code. Wrong codes count toward the attempt cap;
 * hitting the cap kills the code entirely.
 */
export async function verifyOtp({ kind, principalId, purpose, code }) {
  const record = await prisma.otpCode.findFirst({
    where: {
      kind,
      principalId,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  const fail = () => {
    throw new BadRequestError("Invalid or expired code. Please try again.");
  };

  if (!record) {
    return fail();
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return fail();
  }

  const matches =
    typeof code === "string" &&
    crypto.timingSafeEqual(
      Buffer.from(hashCode(code), "hex"),
      Buffer.from(record.codeHash, "hex")
    );

  if (!matches) {
    // Guarded increment: N concurrent wrong guesses that all read
    // attempts < MAX cannot overshoot the cap - the counter stops at
    // MAX_ATTEMPTS and losers of the guard consume the code outright.
    const counted = await prisma.otpCode.updateMany({
      where: { id: record.id, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) {
      await prisma.otpCode.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }
    return fail();
  }

  // Atomic consume: a raced duplicate verification loses.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) fail();
}

/**
 * Timing decoy for principals that do not exist: mirrors the DB read and the
 * constant-time hash compare a wrong code costs against a real account, then
 * throws the SAME generic error verifyOtp uses - so neither the response body
 * nor its timing separates "unknown identifier" from "wrong code".
 */
export async function verifyOtpAgainstNothing({ kind, purpose, code }) {
  // The real query shape with a guaranteed-empty result (ids start at 1).
  await prisma.otpCode.findFirst({
    where: {
      kind,
      principalId: -1,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  crypto.timingSafeEqual(
    Buffer.from(hashCode(typeof code === "string" ? code : ""), "hex"),
    Buffer.from(hashCode("decoy"), "hex")
  );

  throw new BadRequestError("Invalid or expired code. Please try again.");
}

/** Scheduled cleanup of expired codes (BullMQ job). */
export async function cleanupExpiredOtpCodes() {
  const { count } = await prisma.otpCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
