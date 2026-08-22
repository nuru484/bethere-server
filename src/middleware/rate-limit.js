// src/middleware/rate-limit.js
import rateLimit, { ipKeyGenerator, MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { getRedisClient } from "../lib/redis.js";
import { flagAnomaly } from "../services/anomaly.service.js";
import ENV from "../config/env.js";

/**
 * Limiters are skipped under NODE_ENV=test by default so unrelated suites
 * never trip them, but the rate-limit tests re-enable them through this
 * override to exercise the real 429 behavior.
 */
let testOverrideEnabled = false;
export function setRateLimitTestOverride(enabled) {
  testOverrideEnabled = enabled;
}
const skipInTest = () => ENV.NODE_ENV === "test" && !testOverrideEnabled;

/** Memory stores created in test mode, so tests can reset counters. */
const memoryStores = [];
export function resetRateLimitCounters() {
  for (const store of memoryStores) store.resetAll();
}

/**
 * Counter store shared across instances: Redis when the shared client
 * exists, a tracked in-memory store otherwise (tests). Each limiter gets its
 * own prefix so windows never collide on one IP.
 */
const createStore = (prefix) => {
  const client = getRedisClient();
  if (!client) {
    const store = new MemoryStore();
    memoryStores.push(store);
    return store;
  }
  return new RedisStore({
    prefix,
    sendCommand: (command, ...args) => client.call(command, ...args),
  });
};

// Shared 429 response shape - matches the app's error envelope so the client's
// error extractor reads `message` the same way it does for every other error.
/**
 * Keys a limiter on the AUTHENTICATED principal, falling back to IP only when
 * the request is anonymous. Essential for the attendance and enrollment
 * surfaces: a whole venue shares one NAT address, so an IP-keyed limiter would
 * let the first handful of attendees exhaust the window and 429 everybody else
 * at the event - exactly the people the endpoint exists for. Requires the
 * limiter to be mounted AFTER authenticateJWT.
 */
const perPrincipal = (req) =>
  req.user ? `${req.user.kind}:${req.user.id}` : ipKeyGenerator(req.ip);

const rateLimitResponse = (message) => ({
  status: "error",
  message,
  code: "RATE_LIMIT_EXCEEDED",
});

// Credential/cost limiters (login, OTP request/verify, password reset) fail
// CLOSED (passOnStoreError: false): a Redis outage must not silently disable
// brute-force protection on the surfaces that guard credentials, even at the
// price of erroring those endpoints while Redis is down. Availability
// limiters (attendance, enrollment, refresh, demo) stay fail-open - losing
// Redis should not take normal usage of the product down with it.

/**
 * Limits how often a client can request a password reset email. Tighter, because
 * each call sends an email and is the main abuse/enumeration vector.
 */
export const passwordResetRequestLimiter = rateLimit({
  store: createStore("rl:reset-req:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many password reset requests. Please try again in a few minutes."
  ),
});

/**
 * Limits token verification / final reset attempts to slow brute-force probing
 * of reset tokens, while staying lenient enough for normal retries.
 */
export const passwordResetConfirmLimiter = rateLimit({
  store: createStore("rl:reset-confirm:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many attempts. Please try again in a few minutes."
  ),
});

/**
 * Brute-force cap for login: only FAILED attempts count toward the limit, so
 * a legitimate user signing in all day never locks themselves out while a
 * password-guesser hits the wall.
 */
export const loginLimiter = rateLimit({
  store: createStore("rl:login:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many failed login attempts. Please try again in a few minutes."
  ),
});

/**
 * OTP request/verify surfaces: tight windows because every request sends an
 * SMS or email, and codes are 6 digits.
 */
export const otpRequestLimiter = rateLimit({
  store: createStore("rl:otp-req:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many code requests. Please try again in a few minutes."
  ),
});

/**
 * Check-in/check-out surfaces. Unlimited, they leave the rotating venue code
 * free to brute-force and let each failed attempt upload evidence frames to
 * Cloudinary at our expense. A genuine attendee needs a couple of tries per
 * event, so this is generous for real use and hostile to scripted probing.
 */
export const attendanceAttemptLimiter = rateLimit({
  store: createStore("rl:attendance:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  // Hitting this wall IS the RAPID_ATTEMPTS anomaly: a genuine attendee
  // never needs 20 tries in 15 minutes. Flagged best-effort (fire and
  // forget) for an attendant principal, then the standard 429 envelope.
  handler: async (req, res) => {
    if (req.user?.kind === "USER") {
      // Awaited (flagAnomaly never throws): only the already-throttled 429
      // path pays the write, and the flag is durably recorded before the
      // response goes out.
      await flagAnomaly({
        userId: Number(req.user.id),
        type: "RAPID_ATTEMPTS",
        severity: "MEDIUM",
        detail: { route: req.originalUrl },
      });
    }
    res
      .status(429)
      .json(
        rateLimitResponse(
          "Too many check-in attempts. Please wait a few minutes and try again."
        )
      );
  },
});

/**
 * Face ENROLLMENT, step 1: minting the liveness challenge. Cheap (a random
 * challenge plus one row), but not free, so it gets its own bucket with its
 * own prefix. It must NOT share the enrollment bucket: one attempt is
 * challenge + submit, so a shared counter charges every attempt two units and
 * halves the real enrollment budget.
 */
export const faceChallengeLimiter = rateLimit({
  store: createStore("rl:enroll-challenge:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  // Deliberately above the submit budget: a client may mint a challenge and
  // abandon the capture (camera denied, page closed) without spending an
  // enrollment attempt.
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many face registration attempts. Please wait a few minutes and try again."
  ),
});

/**
 * Face ENROLLMENT, step 2: the expensive one. POST /facescan runs the face
 * engine over up to 16 frames - sequential WASM inference on the request
 * thread - so an unlimited endpoint lets one authenticated user pin the event
 * loop. Enrollment is a once-per-account action, so 10 real attempts per
 * window is generous.
 */
export const faceEnrollmentLimiter = rateLimit({
  store: createStore("rl:enroll:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many face registration attempts. Please wait a few minutes and try again."
  ),
});

/**
 * Step-by-step endpoints charge PER ACTION, not per attempt: one check-in or
 * enrollment is several verified uploads (plus a retry when a step is missed).
 * These buckets are sized for that per-step traffic so an honest multi-step scan
 * is never throttled, while still capping the ML-on-the-request-thread cost.
 */
export const attendanceStepLimiter = rateLimit({
  store: createStore("rl:attendance-step:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  // ~3 actions/scan + retries: 60 covers many honest scans per window.
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: async (req, res) => {
    if (req.user?.kind === "USER") {
      await flagAnomaly({
        userId: Number(req.user.id),
        type: "RAPID_ATTEMPTS",
        severity: "MEDIUM",
        detail: { route: req.originalUrl },
      });
    }
    res
      .status(429)
      .json(
        rateLimitResponse(
          "Too many scan attempts. Please wait a few minutes and try again."
        )
      );
  },
});

export const faceEnrollStepLimiter = rateLimit({
  store: createStore("rl:enroll-step:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  // Enrollment is once per account, but each of ~3 steps may be retried.
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many face registration attempts. Please wait a few minutes and try again."
  ),
});

/**
 * Cross-device pairing. Starting a hand-off (and the phone reading its context)
 * is cheap; the laptop then POLLS the status on a short interval, so that bucket
 * is deliberately roomy for a few minutes of 2s polling per pairing.
 */
export const pairingStartLimiter = rateLimit({
  store: createStore("rl:pairing-start:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many pairing attempts. Please wait a few minutes and try again."
  ),
});

export const pairingPollLimiter = rateLimit({
  store: createStore("rl:pairing-poll:"),
  keyGenerator: perPrincipal,
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse("Slow down and try again in a moment."),
});

/**
 * Refresh endpoint: a JWT verify + DB lookups per hit and the surface a stolen
 * token would be replayed against. Generous enough for normal 30-min rotation,
 * tight enough to stop rapid probing.
 */
export const refreshTokenLimiter = rateLimit({
  store: createStore("rl:refresh:"),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many refresh attempts. Please try again in a few minutes."
  ),
});

/**
 * Demo login: every hit mints a session, so skipSuccessfulRequests would never
 * limit it. Counts all attempts to cap abuse of the open portfolio endpoint.
 */
export const demoLoginLimiter = rateLimit({
  store: createStore("rl:demo:"),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many demo logins. Please try again in a few minutes."
  ),
});

export const otpVerifyLimiter = rateLimit({
  store: createStore("rl:otp-verify:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: rateLimitResponse(
    "Too many attempts. Please try again in a few minutes."
  ),
});
