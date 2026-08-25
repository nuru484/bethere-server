// src/middleware/authenticate-handoff.js
//
// Authentication for the cross-device "scan from phone" endpoints ONLY. The
// phone has no session cookie; it carries the short-lived hand-off token from
// the pairing QR as a Bearer credential. This middleware verifies that token
// (and that its pairing is still live) and sets a MINIMAL principal so the
// reused capture services and their `assertAttendant` gate work unchanged.
//
// Mounted only on the /pairing capture routes, so the narrow token can never
// reach a cookie-authenticated route. req.handoff carries the exact capture the
// token is scoped to (scope + event + mode); controllers must trust THAT, not
// anything the client sends, for the event/mode.
import { setSentryUser } from "../lib/sentry.js";
import { UnauthorizedError } from "./error-handler.js";
import { verifyHandoffToken } from "../services/pairing.service.js";

/** Reads the Bearer hand-off token from the Authorization header. */
function bearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, value] = header.split(" ");
  return scheme === "Bearer" && value ? value : null;
}

export const authenticateHandoff = async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw new UnauthorizedError("Missing pairing token.", {
        code: "PAIRING_TOKEN_MISSING",
      });
    }

    const context = await verifyHandoffToken(token);

    // Minimal USER principal so assertAttendant + the services (which read
    // req.user.id as the actor) behave exactly as for a cookie session.
    req.user = { id: context.userId, kind: "USER", role: "USER" };
    setSentryUser(context.userId);
    req.handoff = {
      pairingId: context.pairingId,
      scope: context.scope,
      eventId: context.eventId,
      mode: context.mode,
    };
    next();
  } catch (error) {
    next(error);
  }
};
