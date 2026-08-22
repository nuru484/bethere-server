// src/services/auth.service.js
//
// The auth core for BOTH principals (Admin staff, User attendants):
// credential login with an optional 2FA second step, passwordless OTP login
// for attendants, refresh-token ROTATION with replay-as-theft response,
// logout, and session revocation. Every refresh JWT carries a jti whose
// sha256 hash is registered in RefreshToken; exchanging it consumes the row
// and issues a successor. Presenting a consumed jti again is treated as
// theft: the principal's tokenVersion (session epoch) is bumped and every
// outstanding token dies, so a stolen token cannot outlive its discovery.
//
// Tokens travel ONLY in httpOnly cookies (see utils/cookie-manager.js);
// this module mints/verifies them but never touches the response itself.
// Every login method ends in the same issueSession(), so new grant types
// (e.g. face-scan login) only add a new proof check in front of it.
import crypto from "node:crypto";
import { compare, hash } from "bcrypt";
import jwt from "jsonwebtoken";
import ENV from "../config/env.js";
import { prisma } from "../config/prisma-client.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../middleware/error-handler.js";
import { invalidateCachedTokenVersion } from "../utils/authz-cache.js";
import { JWT_ALGORITHMS } from "../utils/verify-jwt-token.js";
import { tableFor } from "../utils/principal.js";
import { TOKEN_LIFETIMES } from "../config/constants.js";
import {
  issueOtp,
  verifyOtp,
  verifyOtpAgainstNothing,
} from "./otp.service.js";

export const KIND_ADMIN = "ADMIN";
export const KIND_USER = "USER";

// Lifetimes come from the shared TOKEN_LIFETIMES definition so the cookie
// maxAge in utils/cookie-manager.js can never drift from the JWT expiry.
const { ACCESS_EXPIRY, REFRESH_EXPIRY_DAYS, PENDING_2FA_EXPIRY } =
  TOKEN_LIFETIMES;
/** Leeway in which re-presenting a just-rotated refresh token is treated as a
 * concurrent-refresh race rather than token theft. Long enough to cover
 * parallel tabs, short enough that a stolen token is still caught. */
const REFRESH_REUSE_GRACE_MS = 15_000;

const hashJti = (jti) => crypto.createHash("sha256").update(jti).digest("hex");

// A real bcrypt hash to compare against when no account (or no password) is
// found, so the not-found path costs the same as a wrong-password path and
// login timing can't be used to enumerate registered emails.
const dummyHashPromise = hash("bethere-timing-equalizer", 10);

/** Scoped principal lookup by id (soft-deleted rows read as absent). */
export const findPrincipal = (kind, id) =>
  tableFor(kind).findFirst({ where: { id } });

/**
 * Resolves an email to a principal, admins first (staff sign in with the
 * same form). Returns { kind, principal } or null.
 */
export async function findPrincipalByEmail(email) {
  const admin = await prisma.admin.findFirst({ where: { email } });
  if (admin) return { kind: KIND_ADMIN, principal: admin };
  const user = await prisma.user.findFirst({ where: { email } });
  if (user) return { kind: KIND_USER, principal: user };
  return null;
}

/** Strips secrets/biometrics and injects the role the client keys off. */
export function toSafeUser(kind, principal) {
  const {
    password,
    faceScan,
    faceScanEnc,
    tokenVersion: _tv,
    deletedAt: _deletedAt,
    ...rest
  } = principal;
  return {
    ...rest,
    role: kind,
    // Lets the client decide whether the change-password form needs a current
    // password field (passwordless OTP accounts set their first one).
    hasPassword: password != null,
    ...(kind === KIND_USER
      ? { hasFaceScan: faceScan != null || faceScanEnc != null }
      : {}),
  };
}

/**
 * Mints an access + refresh pair and registers the refresh jti. The access
 * token carries kind, a role claim equal to the kind (so authorizeRole and
 * the client keep working unchanged), and the session epoch (tv).
 */
export async function issueSession(kind, principal) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.refreshToken.create({
    data: { kind, principalId: principal.id, jtiHash: hashJti(jti), expiresAt },
  });

  const accessToken = jwt.sign(
    // typ marks this as a SESSION credential. Other tokens signed with the
    // same secret (2FA pending, liveness challenges) carry a `purpose` claim
    // instead, and authenticateJWT rejects those explicitly - their
    // invalidity as access tokens must never rest on an incidental
    // claim-shape difference.
    { id: principal.id, kind, role: kind, tv: principal.tokenVersion, typ: "access" },
    ENV.ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );

  const refreshToken = jwt.sign(
    { id: principal.id, kind, jti },
    ENV.REFRESH_TOKEN_SECRET,
    { expiresIn: `${REFRESH_EXPIRY_DAYS}d` }
  );

  return { accessToken, refreshToken };
}

/**
 * Email + password step. When 2FA is enabled the session is NOT issued yet:
 * a code goes out and the caller receives a short-lived pending token to
 * set as the twoFaPending cookie.
 */
export async function loginWithPassword(email, password) {
  const resolved = await findPrincipalByEmail(email);
  const storedHash = resolved?.principal?.password;

  // Always run exactly one bcrypt compare - against the real hash when we have
  // one, against a dummy otherwise - so a missing account, a passwordless
  // account, and a wrong password all take the same time.
  const passwordMatches = await compare(
    password ?? "",
    storedHash ?? (await dummyHashPromise)
  );

  if (!resolved || !storedHash || !passwordMatches) {
    // 401, the conventional status for failed authentication. The code lets
    // the client distinguish "wrong credentials" from a session-expiry 401.
    throw new UnauthorizedError("Invalid Credentials", {
      code: "INVALID_CREDENTIALS",
    });
  }

  const { kind, principal } = resolved;

  if (principal.twoFactorEnabled) {
    // tolerateCooldown: the pending token is minted AFTER the code goes out, so
    // a 429 here (tab refresh, retry within the minute) would leave the user
    // holding a valid code with no pending cookie to submit it with. Reusing
    // the outstanding code keeps that login completable.
    const { channel } = await issueOtp({
      kind,
      principal,
      purpose: "TWO_FACTOR",
      tolerateCooldown: true,
    });
    const pendingToken = jwt.sign(
      { id: principal.id, kind, purpose: "2FA_PENDING" },
      ENV.ACCESS_TOKEN_SECRET,
      { expiresIn: PENDING_2FA_EXPIRY }
    );
    return { twoFactorRequired: true, channel, pendingToken };
  }

  const tokens = await issueSession(kind, principal);
  return { ...tokens, user: toSafeUser(kind, principal) };
}

/** Second factor: the pending cookie proves the password step, the code
 * proves possession of the channel. */
export async function verifyTwoFactorLogin(pendingToken, code) {
  let decoded;
  try {
    decoded = jwt.verify(pendingToken, ENV.ACCESS_TOKEN_SECRET, {
      algorithms: JWT_ALGORITHMS,
    });
  } catch {
    throw new UnauthorizedError("Your login expired. Please sign in again.", {
      code: "2FA_PENDING_EXPIRED",
    });
  }
  if (decoded?.purpose !== "2FA_PENDING") {
    throw new UnauthorizedError("Your login expired. Please sign in again.", {
      code: "2FA_PENDING_EXPIRED",
    });
  }

  await verifyOtp({
    kind: decoded.kind,
    principalId: decoded.id,
    purpose: "TWO_FACTOR",
    code,
  });

  const principal = await findPrincipal(decoded.kind, decoded.id);
  if (!principal) {
    throw new UnauthorizedError("Account no longer exists.", {
      code: "USER_NOT_FOUND",
    });
  }

  const tokens = await issueSession(decoded.kind, principal);
  return { ...tokens, user: toSafeUser(decoded.kind, principal) };
}

/**
 * Passwordless OTP login - ATTENDANTS ONLY (staff keep password + 2FA).
 * Phone-first: the code goes by SMS when the account has a phone, email
 * otherwise. Enumeration-safe: unknown identifiers get the same response.
 */
export async function requestOtpLogin(identifier) {
  // Enumeration-safe: the channel is derived from the identifier's FORMAT, and
  // the code is delivered on that same channel, so a known and an unknown
  // identifier produce byte-identical responses. Deriving it from the account
  // instead (phone ? SMS : EMAIL) would answer "SMS" to a typed email address
  // and thereby prove the account exists.
  const looksLikePhone = /^\+?\d[\d\s-]{5,}$/.test(identifier ?? "");
  const channel = looksLikePhone ? "SMS" : "EMAIL";

  const user = await prisma.user.findFirst({
    where: { OR: [{ phone: identifier }, { email: identifier }] },
  });

  if (user) {
    // tolerateCooldown: a 429 for a real account against a 200 for an unknown
    // one is the same oracle by another route - two probes would separate them.
    // Inside the window the outstanding code simply stands.
    // deferDelivery: the SMS/email goes out fire-and-forget, so the response
    // does not take a provider round-trip longer for a known identifier.
    await issueOtp({
      kind: KIND_USER,
      principal: user,
      purpose: "LOGIN",
      channel,
      tolerateCooldown: true,
      deferDelivery: true,
    });
  }

  // ALWAYS the format-derived channel, never the issued one. A REUSED code may
  // sit on the other channel (they typed their phone a minute ago and their
  // email now), but reporting that answers "SMS" to a typed email address -
  // which proves both that the account exists and that it has a phone. An
  // unknown identifier can only ever echo the format, so the known answer must
  // too. The cost is the rare "check your inbox" for a code sitting in their
  // texts; a second request after the 60s cooldown puts it where they were told.
  return { channel };
}

export async function verifyOtpLogin(identifier, code) {
  let user = await prisma.user.findFirst({
    where: { OR: [{ phone: identifier }, { email: identifier }] },
  });
  if (!user) {
    // Unknown identifier: pay the same DB-read + hash-compare cost a wrong
    // code pays and fail with the identical error, so this endpoint cannot
    // confirm that an account exists. It always throws today; the explicit
    // throw after it makes that a property of THIS function, so a future early
    // return there cannot fall through to verifyOtp with user === null and
    // 500 an unauthenticated endpoint.
    await verifyOtpAgainstNothing({ kind: KIND_USER, purpose: "LOGIN", code });
    throw new BadRequestError("Invalid or expired code. Please try again.");
  }

  await verifyOtp({
    kind: KIND_USER,
    principalId: user.id,
    purpose: "LOGIN",
    code,
  });

  // A successful SMS login proves phone possession.
  if (user.phone === identifier && !user.phoneVerified) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { phoneVerified: true },
    });
  }

  const tokens = await issueSession(KIND_USER, user);
  return { ...tokens, user: toSafeUser(KIND_USER, user) };
}

/**
 * One-click demo login (portfolio only). Signs into the seeded demo account
 * for the requested role and issues a normal session - no credentials ever
 * touch the client. Gated by DEMO_LOGIN_ENABLED so it is inert unless a
 * deployment explicitly opts in.
 */
export async function demoLogin(role) {
  if (!ENV.DEMO_LOGIN_ENABLED) {
    throw new ForbiddenError("Demo login is not enabled.");
  }
  const kind = role === KIND_ADMIN ? KIND_ADMIN : KIND_USER;
  const email = kind === KIND_ADMIN ? ENV.DEMO_ADMIN_EMAIL : ENV.DEMO_ATTENDANT_EMAIL;

  const principal = await tableFor(kind).findFirst({ where: { email } });
  if (!principal) {
    throw new NotFoundError(
      "The demo account is not set up. Seed the database first."
    );
  }

  const tokens = await issueSession(kind, principal);
  return { ...tokens, user: toSafeUser(kind, principal) };
}

/**
 * Rotates a refresh token: consumes the presented jti and issues a
 * successor. A consumed/unknown jti is the theft signal - the epoch bump
 * plus token purge kills every session for that principal.
 */
export async function rotateRefreshToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, ENV.REFRESH_TOKEN_SECRET, {
      algorithms: JWT_ALGORITHMS,
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw new UnauthorizedError("Refresh token expired. Please log in again.", {
        code: "TOKEN_EXPIRED",
      });
    }
    throw new UnauthorizedError("Invalid refresh token", {
      code: "INVALID_TOKEN",
    });
  }

  if (!decoded?.id || !decoded?.jti || !decoded?.kind) {
    throw new UnauthorizedError("Invalid refresh token payload", {
      code: "INVALID_TOKEN",
    });
  }

  const jtiHash = hashJti(decoded.jti);

  // Atomic consume: only one concurrent exchange of the same token wins.
  const consumed = await prisma.refreshToken.updateMany({
    where: { jtiHash, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });

  if (consumed.count === 0) {
    const known = await prisma.refreshToken.findUnique({ where: { jtiHash } });

    if (known?.consumedAt) {
      const sinceConsumed = Date.now() - known.consumedAt.getTime();

      // A benign ROTATION RACE, not theft: two tabs (or two parallel requests)
      // both 401 on the same expired access token and both present the same
      // refresh cookie. One wins the atomic consume; the loser arrives
      // milliseconds later. Treating that as theft would revoke every session
      // and hard-log the user out of a perfectly normal page load, so a short
      // leeway re-issues instead. Replays after the leeway are still theft.
      if (
        sinceConsumed <= REFRESH_REUSE_GRACE_MS &&
        known.expiresAt.getTime() > Date.now()
      ) {
        // Claim the leeway ATOMICALLY and only once. Without this bound a token
        // replayed repeatedly inside the window would mint an independent
        // 7-day session on every call, and because the original is never
        // presented again afterwards the theft response would never fire. One
        // re-issue covers the real case (two tabs); a second is treated as
        // theft below.
        const claimed = await prisma.refreshToken.updateMany({
          where: { jtiHash, reusedAt: null },
          data: { reusedAt: new Date() },
        });

        if (claimed.count === 0) {
          await revokeAllSessions(decoded.kind, decoded.id);
          throw new UnauthorizedError("Invalid refresh token", {
            code: "INVALID_TOKEN",
          });
        }

        const principal = await findPrincipal(decoded.kind, decoded.id);
        if (!principal) {
          throw new UnauthorizedError(
            "Account no longer exists. Please log in again.",
            { code: "INVALID_TOKEN" }
          );
        }
        const tokens = await issueSession(decoded.kind, principal);
        return { ...tokens, user: toSafeUser(decoded.kind, principal) };
      }

      // Replay of an already-rotated token: someone holds a stolen copy.
      await revokeAllSessions(decoded.kind, decoded.id);
    }

    throw new UnauthorizedError("Invalid refresh token", {
      code: "INVALID_TOKEN",
    });
  }

  const principal = await findPrincipal(decoded.kind, decoded.id);
  if (!principal) {
    throw new UnauthorizedError("Account no longer exists. Please log in again.", {
      code: "INVALID_TOKEN",
    });
  }

  const tokens = await issueSession(decoded.kind, principal);
  return { ...tokens, user: toSafeUser(decoded.kind, principal) };
}

/**
 * Retention: deletes refresh-token rows past their expiry. Consumed-but-
 * unexpired rows are KEPT on purpose - the replay-as-theft check needs them to
 * recognise a stolen token during its 7-day validity window.
 */
export async function cleanupExpiredRefreshTokens() {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

/** Consumes the presented refresh token (idempotent, never throws). */
export async function logout(token) {
  try {
    const decoded = jwt.verify(token, ENV.REFRESH_TOKEN_SECRET, {
      algorithms: JWT_ALGORITHMS,
    });
    if (decoded?.kind && decoded?.id) {
      // Bump the session epoch AND purge every refresh token for this
      // principal, not just the presented jti. Deleting one row leaves the
      // access token already in the browser valid for the rest of its 30m
      // life, so a token captured off a shared machine keeps working after the
      // user clicks "log out". revokeAllSessions increments tokenVersion,
      // which the per-request epoch check rejects immediately, matching how
      // password change/reset/deletion/theft already behave. It also clears
      // the cached epoch (running outside a transaction), so the revocation
      // takes effect on the very next request.
      await revokeAllSessions(decoded.kind, decoded.id);
    } else if (decoded?.jti) {
      // Older tokens without a kind claim: fall back to killing just this jti.
      await prisma.refreshToken.deleteMany({
        where: { jtiHash: hashJti(decoded.jti) },
      });
    }
  } catch {
    // An invalid/expired token has nothing to revoke.
  }
}

/**
 * Full session revocation for a principal: epoch bump + refresh purge. Used
 * by password change/reset, 2FA toggles, deletion, and theft response.
 * Accepts a transaction client so callers can make the revocation atomic
 * with the mutation that demanded it (e.g. account deletion).
 *
 * The cached epoch is dropped only when this runs OUTSIDE a transaction.
 * Invalidating mid-transaction is worse than not invalidating at all: a
 * concurrent request misses the cache, reads the still-UNCOMMITTED old
 * tokenVersion, and repopulates the entry with a fresh 60s TTL - so a revoked
 * access token keeps working for up to a minute AFTER the commit. Callers
 * passing a tx must call invalidateRevokedSessionsCache once it commits.
 */
export async function revokeAllSessions(kind, principalId, db = prisma) {
  await tableFor(kind, db).update({
    where: { id: principalId },
    data: { tokenVersion: { increment: 1 } },
  });
  await db.refreshToken.deleteMany({ where: { kind, principalId } });
  if (db === prisma) invalidateRevokedSessionsCache(kind, principalId);
}

/**
 * Drops the cached session epoch after a revocation that ran inside a
 * transaction. Call it once the transaction has COMMITTED.
 */
export function invalidateRevokedSessionsCache(kind, principalId) {
  invalidateCachedTokenVersion(kind, principalId);
}
