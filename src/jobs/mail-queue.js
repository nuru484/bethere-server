// src/jobs/mail-queue.js
//
// The queue for email that must not fail the action that triggered it, and
// must not be lost either: a reset link, a code sent down the deferred path.
//
// Sending those inline was the old shape and it was wrong in both directions.
// The reset email was awaited and its failure swallowed, so one refused API
// call left the only route back into an account silently gone. Queued, the
// same failure costs a few seconds and lands on the next attempt; a send that
// exhausts its attempts stays on the failed set where it can be read.
//
// Mail a person is WAITING for stays awaited at the call site, so a failure
// can reach them while they are still looking at the screen.
import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis-connection.js";
import { getRequestId } from "../lib/request-context.js";
import logger from "../utils/logger.js";
import sendMail from "../utils/send-mail.js";

export const MAIL_QUEUE_NAME = "mailQueue";

export const mailQueue = new Queue(MAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    // Five attempts with exponential backoff from 15s: a provider rate limit,
    // a brief outage, a restart. Roughly four minutes of patience, without
    // hammering a provider that is already refusing us.
    attempts: 5,
    backoff: { type: "exponential", delay: 15000 },
    removeOnComplete: 100,
    // Bounded: `false` would keep every failed job in Redis forever.
    removeOnFail: { count: 500 },
  },
});

/**
 * Hands an email to the queue. Never throws: the caller has already done the
 * thing the email is about. If the enqueue itself fails (Redis down) the
 * message is sent inline instead, so an outage costs the retries, not the
 * email.
 *
 * @param {Object} options - Same shape as sendMail's options.
 * @returns {Promise<void>}
 */
export const enqueueEmail = async (options) => {
  try {
    await mailQueue.add("send-email", {
      ...options,
      requestId: getRequestId(),
    });
  } catch (error) {
    logger.error(
      error,
      "Email could not be queued; sending inline instead"
    );
    try {
      await sendMail(options);
    } catch (sendError) {
      logger.error(sendError, "Inline email fallback failed");
    }
  }
};
