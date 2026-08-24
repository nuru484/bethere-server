// src/lib/sentry.js
//
// Error tracking. Fully optional: without SENTRY_DSN every function is a
// no-op, so dev and test runs need no account.
import * as Sentry from "@sentry/node";
import ENV from "../config/env.js";

let enabled = false;

export function initSentry() {
  if (!ENV.SENTRY_DSN) return;
  Sentry.init({
    dsn: ENV.SENTRY_DSN,
    environment: ENV.SENTRY_ENVIRONMENT ?? ENV.NODE_ENV,
    tracesSampleRate: ENV.SENTRY_TRACES_SAMPLE_RATE,
  });
  enabled = true;
}

/** Reports an error with request context; no-op when disabled. */
export function captureError(error, context = {}) {
  if (!enabled) return;
  Sentry.captureException(error, { extra: context });
}

/** Flushes buffered events before the process exits. */
export async function flushSentry(timeoutMs = 2000) {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}
