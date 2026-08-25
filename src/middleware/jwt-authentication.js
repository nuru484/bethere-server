// src/middleware/jwt-authentication.js
//
// Cookie-only authentication: the access token lives in an httpOnly cookie
// (never readable by page JavaScript), and every request re-checks the
// principal's session epoch so revocation applies mid-token-lifetime.
import ENV from "../config/env.js";
import { setSentryUser } from "../lib/sentry.js";
import { UnauthorizedError } from "./error-handler.js";
import {
  getCachedTokenVersion,
  setCachedTokenVersion,
} from "../utils/authz-cache.js";
import { CookieManager } from "../utils/cookie-manager.js";
import { tableFor } from "../utils/principal.js";
import { verifyJwtToken } from "../utils/verify-jwt-token.js";

const isKind = (value) => value === "ADMIN" || value === "USER";

/** The principal's live epoch, behind the shared short cache. findFirst
 * keeps the soft-delete scope: deleted accounts read as gone at once. */
const resolveLiveTokenVersion = async (kind, id) => {
  const cached = await getCachedTokenVersion(kind, id);
  if (cached !== undefined) return cached;

  const principal = await tableFor(kind).findFirst({
    where: { id },
    select: { tokenVersion: true },
  });
  const version = principal?.tokenVersion ?? null;
  await setCachedTokenVersion(kind, id, version);
  return version;
};

export const authenticateJWT = async (req, res, next) => {
  const accessToken = CookieManager.getAccessToken(req);

  if (!accessToken) {
    return next(
      new UnauthorizedError("Not authenticated", {
        code: "NO_TOKEN",
        layer: "jwt",
      })
    );
  }

  try {
    const decodedUser = await verifyJwtToken(
      accessToken,
      ENV.ACCESS_TOKEN_SECRET
    );

    // Explicit token-type check. The same secret signs purpose-tagged tokens
    // (2FA pending, liveness challenges); they must be rejected as SESSION
    // credentials deliberately, not because they happen to lack a tv claim.
    // A missing typ is tolerated only for legacy in-flight access tokens,
    // which never carry a purpose.
    if (
      decodedUser.purpose !== undefined ||
      (decodedUser.typ !== undefined && decodedUser.typ !== "access") ||
      !isKind(decodedUser.kind)
    ) {
      return next(
        new UnauthorizedError("Invalid access token", {
          code: "INVALID_TOKEN",
          layer: "jwt",
        })
      );
    }

    const liveVersion = await resolveLiveTokenVersion(
      decodedUser.kind,
      decodedUser.id
    );
    if (liveVersion === null) {
      return next(
        new UnauthorizedError("Account no longer exists. Please log in.", {
          code: "USER_NOT_FOUND",
          layer: "jwt",
        })
      );
    }
    if (decodedUser.tv !== liveVersion) {
      return next(
        new UnauthorizedError("Session revoked. Please log in again.", {
          code: "TOKEN_EXPIRED",
          layer: "jwt",
        })
      );
    }

    req.user = decodedUser;
    setSentryUser(decodedUser.id);

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return next(
        new UnauthorizedError("Access token expired.", {
          code: "TOKEN_EXPIRED",
          layer: "jwt",
        })
      );
    }

    if (error.name === "JsonWebTokenError") {
      return next(
        new UnauthorizedError("Invalid access token", {
          code: "INVALID_TOKEN",
          layer: "jwt",
        })
      );
    }
    next(error);
  }
};
