// src/lib/sentry.js
//
// Error tracking. Fully optional: without SENTRY_DSN every function is a
// no-op, so dev and test runs need no account.
import * as Sentry from "@sentry/node";
import ENV from "../config/env.js";
import { getRequestId } from "./request-context.js";
import {
  maskSensitiveText,
  sanitizeErrorData,
} from "../utils/sensitive-data.js";

let enabled = false;

/**
 * Strips credentials, one-time codes, biometrics and cookies from an event
 * before it leaves the process: structured fields keep their keys and lose
 * their values, exception messages lose any embedded "key=value" secret.
 */
export function scrubEvent(event) {
  if (event.extra) event.extra = sanitizeErrorData(event.extra);
  if (event.contexts) event.contexts = sanitizeErrorData(event.contexts);
  if (event.request) {
    event.request = sanitizeErrorData(event.request);
    if (typeof event.request.query_string === "string") {
      event.request.query_string = maskSensitiveText(
        event.request.query_string
      );
    }
  }
  if (typeof event.message === "string") {
    event.message = maskSensitiveText(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = maskSensitiveText(exception.value);
    }
  }
  return event;
}

export function initSentry() {
  if (!ENV.SENTRY_DSN) return;
  Sentry.init({
    dsn: ENV.SENTRY_DSN,
    environment: ENV.SENTRY_ENVIRONMENT ?? ENV.NODE_ENV,
    release: ENV.SENTRY_RELEASE,
    tracesSampleRate: ENV.SENTRY_TRACES_SAMPLE_RATE,
    // No IP addresses, cookies or request bodies by default; the request id
    // is enough to find the matching log line.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
  enabled = true;
}

/**
 * Express middleware giving each request its own Sentry scope, so a user set
 * during one request can never bleed into an event from another. Starts
 * anonymous; authenticateJWT fills in the principal.
 */
export function sentryRequestScope(req, res, next) {
  if (!enabled) return next();
  Sentry.withIsolationScope((scope) => {
    scope.setUser(null);
    scope.setTag("requestId", req.requestId);
    next();
  });
}

/**
 * Tags events from the current request with the authenticated principal's
 * opaque id only: no email, phone or name. Null clears it.
 */
export function setSentryUser(id) {
  if (!enabled) return;
  Sentry.getIsolationScope().setUser(id == null ? null : { id: String(id) });
}

/** Reports an error with request context; no-op when disabled. */
export function captureError(error, context = {}) {
  if (!enabled) return;
  Sentry.captureException(error, {
    extra: { requestId: getRequestId(), ...context },
  });
}

/** Flushes buffered events before the process exits. */
export async function flushSentry(timeoutMs = 2000) {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}
