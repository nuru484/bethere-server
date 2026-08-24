// src/jobs/mail-worker.js
//
// Delivers one queued email. Throwing is deliberate: it is what tells BullMQ
// to retry, and what puts a message that never lands on the failed set.
import { Worker } from "bullmq";
import { createRedisConnection } from "../config/redis-connection.js";
import { MAIL_QUEUE_NAME } from "./mail-queue.js";
import logger from "../utils/logger.js";
import sendMail from "../utils/send-mail.js";

export const createMailWorker = () =>
  new Worker(
    MAIL_QUEUE_NAME,
    async (job) => {
      await sendMail(job.data);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      // The provider is the bottleneck, not us.
      limiter: { max: 10, duration: 1000 },
    }
  ).on("failed", (job, error) => {
    logger.error(
      { err: error, subject: job?.data?.subject },
      "Queued email failed"
    );
  });
