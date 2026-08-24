// server.js
//
// Web entrypoint: boots the Express app, optionally runs the BullMQ workers
// in-process (default - set WEB_DISABLE_WORKERS=true when a dedicated worker
// process runs `npm run worker`), and shuts down gracefully on SIGTERM/SIGINT
// so deploys never sever in-flight requests.
import app from "./app.js";
import ENV from "./src/config/env.js";
import { prisma } from "./src/config/prisma-client.js";
import { startWorkers, stopWorkers } from "./src/jobs/lifecycle.js";
import { closeRedisClient } from "./src/lib/redis.js";
import { flushSentry } from "./src/lib/sentry.js";
import { drainDispatches } from "./src/utils/dispatch-async.js";
import logger from "./src/utils/logger.js";
import {
  exitCodeFor,
  installProcessGuards,
} from "./src/utils/process-guards.js";

const port = ENV.PORT;
const server = app.listen(port, () => {
  const message =
    ENV.NODE_ENV === "production"
      ? `App is running in production mode on port ${port}`
      : `App is listening on http://localhost:${port}`;
  logger.info(message);
});

if (!ENV.WEB_DISABLE_WORKERS) {
  startWorkers().catch((err) => {
    logger.error(err, "Failed to start background workers");
  });
}

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    await stopWorkers();
    // Deferred sends (password-reset email, OTP delivery) were dispatched off
    // the response path; a request already answered 200 must not lose its
    // email to the deploy. Bounded, so a hung provider cannot stall the exit.
    await drainDispatches();
    await closeRedisClient();
    await flushSentry();
    await prisma.$disconnect();
    logger.info("Shutdown complete");
    process.exit(exitCodeFor(signal));
  } catch (error) {
    logger.error(error, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

installProcessGuards(shutdown);
