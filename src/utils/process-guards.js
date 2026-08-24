// src/utils/process-guards.js
//
// Process-level failure handlers shared by server.js and worker.js. After an
// uncaught exception or unhandled rejection the process state is undefined,
// so both report the error, flush the tracker (the event would otherwise die
// with the process), and hand off to the entrypoint's shutdown path; the
// platform restarts the process.
import { captureError, flushSentry } from "../lib/sentry.js";
import logger from "./logger.js";

const asError = (reason) =>
  reason instanceof Error ? reason : new Error(String(reason));

const CRASH_SOURCES = new Set(["uncaughtException", "unhandledRejection"]);

/**
 * Exit status for a completed shutdown: a signal is a clean stop, a crash
 * source stays non-zero so the platform records the restart as a failure.
 */
export const exitCodeFor = (source) => (CRASH_SOURCES.has(source) ? 1 : 0);

/**
 * @param {(signal: string) => Promise<void>} shutdown
 * @param {{ target?: NodeJS.EventEmitter }} [options] emitter to listen on
 */
export function installProcessGuards(shutdown, { target = process } = {}) {
  const handle = (source) => (reason) => {
    const error = asError(reason);
    logger.fatal({ err: error, source }, `${source} in process`);
    captureError(error, { source });
    void flushSentry().finally(() => shutdown(source));
  };

  target.on("unhandledRejection", handle("unhandledRejection"));
  target.on("uncaughtException", handle("uncaughtException"));
}
