// src/services/venue-code.service.js
//
// The rotating venue code: proof that a check-in happened AT the venue. A
// screen at the location shows a QR that changes every 30s; scanning it is the
// presence gate (paired with server-side face liveness for identity).
//
// Codes are STATELESS: each is a keyed hash (HMAC-SHA256) of the event's secret
// and the current time window. Nothing polls or writes the database to rotate
// them - the venue display fetches a batch and cycles locally on its own clock,
// and validating a scanned code just recomputes the current window's value.
// That keeps ongoing database load at zero (only real check-ins touch it).
import crypto from "node:crypto";
import { prisma } from "../config/prisma-client.js";
import { VENUE_CODE } from "../config/constants.js";

/** Exactly the lowercase-hex shape codeForWindow mints. */
const HEX_CODE_RE = new RegExp(`^[0-9a-f]{${VENUE_CODE.CODE_HEX_LENGTH}}$`);

/** The time-window index for a moment (one window per PERIOD_MS). */
const windowFor = (ms) => Math.floor(ms / VENUE_CODE.PERIOD_MS);

/** The code for a given secret + window: truncated keyed hash, unguessable. */
function codeForWindow(secret, windowIndex) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(windowIndex))
    .digest("hex")
    .slice(0, VENUE_CODE.CODE_HEX_LENGTH);
}

/** Lazily ensures the event has a venue secret, generating one if absent. */
export async function ensureVenueSecret(eventId) {
  const event = await prisma.event.findFirst({
    where: { id: eventId },
    select: { id: true, venueSecret: true },
  });
  if (!event) return null;
  if (event.venueSecret) return event.venueSecret;

  // Guarded claim, then re-read. A plain read-then-write lets two concurrent
  // callers (the venue display and the first scanner) mint DIFFERENT secrets;
  // the loser's write wins and every code the display has already fetched
  // fails validation for its whole batch window.
  const secret = crypto.randomBytes(32).toString("hex");
  await prisma.event.updateMany({
    where: { id: eventId, venueSecret: null },
    data: { venueSecret: secret },
  });
  const claimed = await prisma.event.findFirst({
    where: { id: eventId },
    select: { venueSecret: true },
  });
  return claimed?.venueSecret ?? null;
}

/**
 * A batch of upcoming codes for the venue display to render and cycle through
 * locally, so it never polls every rotation. Each entry carries its validity
 * window so the display knows when to switch.
 */
export function upcomingCodes(secret, now = Date.now(), count = VENUE_CODE.BATCH_SIZE) {
  const start = windowFor(now);
  return Array.from({ length: count }, (_, i) => {
    const w = start + i;
    return {
      code: codeForWindow(secret, w),
      validFrom: new Date(w * VENUE_CODE.PERIOD_MS).toISOString(),
      validTo: new Date((w + 1) * VENUE_CODE.PERIOD_MS).toISOString(),
    };
  });
}

/**
 * True when `code` matches the current window or one within the skew tolerance.
 * Timing-safe comparison; a wrong-length code fails fast.
 *
 * `skewWindows` is widened at the UPLOAD step: the code is scanned at the
 * preflight and re-sent with the frames, so it must stay acceptable for the
 * whole challenge lifetime. With the default tolerance a user who scans near
 * the end of a window has as little as ~30s to perform three prompted actions
 * and upload before the code reads as expired.
 */
export function isValidVenueCode(
  secret,
  code,
  now = Date.now(),
  skewWindows = VENUE_CODE.SKEW_WINDOWS
) {
  // Must be exactly the hex we mint. This also keeps the byte length equal to
  // the string length, so timingSafeEqual (which throws on unequal-length
  // buffers) can never RangeError on a crafted multibyte input.
  if (typeof code !== "string" || !HEX_CODE_RE.test(code)) {
    return false;
  }
  const current = windowFor(now);
  for (let d = -skewWindows; d <= skewWindows; d++) {
    const expected = codeForWindow(secret, current + d);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}
