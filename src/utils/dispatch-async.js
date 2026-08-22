// src/utils/dispatch-async.js
//
// Fire-and-forget dispatch for response-path side effects (email/SMS). On
// enumeration-safe endpoints, awaiting the provider call only for accounts
// that exist makes the response time itself an oracle - a known email takes
// an SMTP round-trip longer than an unknown one. Deferring the send off the
// request keeps the HTTP timing independent of account existence. Failures
// are logged, never surfaced.
import logger from "./logger.js";

/**
 * Deferred tasks still in flight. Untracked, a deploy landing between the 200
 * and the setImmediate simply drops the password-reset email the user was just
 * told to expect; the shutdown path drains this set instead.
 */
const inFlight = new Set();

/** Runs `task` after the current turn; errors go to the logger only. */
export function dispatchAsync(task, description) {
  const settled = new Promise((resolve) => {
    setImmediate(() => {
      Promise.resolve()
        .then(task)
        .catch((error) =>
          logger.error(error, `Deferred dispatch failed: ${description}`)
        )
        .finally(resolve);
    });
  });

  inFlight.add(settled);
  void settled.then(() => inFlight.delete(settled));
}

/**
 * Waits for the deferred sends still in flight, bounded so a hung provider
 * cannot hold a shutdown open past its own timeout.
 */
export async function drainDispatches(timeoutMs = 5000) {
  if (inFlight.size === 0) return;
  logger.info(`Draining ${inFlight.size} deferred dispatch(es)...`);

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });

  await Promise.race([Promise.all([...inFlight]), timeout]);
  clearTimeout(timer);
}
