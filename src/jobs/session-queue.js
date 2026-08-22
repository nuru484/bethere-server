// src/jobs/session-queue.js
import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis-connection.js";

export const sessionQueue = new Queue("sessionQueue", {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    // Bounded: `false` would keep every failed job in Redis forever. The most
    // recent failures are plenty for diagnosis; Sentry has the rest.
    removeOnFail: { count: 500 },
  },
});
