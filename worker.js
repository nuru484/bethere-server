// worker.js
//
// Dedicated worker entrypoint (`npm run worker`). When this process is
// deployed, set WEB_DISABLE_WORKERS=true on the web process so jobs are
// never processed twice.
import http from "node:http";
import ENV from "./src/config/env.js";
import { prisma } from "./src/config/prisma-client.js";
import { startWorkers, stopWorkers } from "./src/jobs/lifecycle.js";
import { closeRedisClient } from "./src/lib/redis.js";
import { flushSentry, initSentry } from "./src/lib/sentry.js";
import { drainDispatches } from "./src/utils/dispatch-async.js";
import logger from "./src/utils/logger.js";
import {
  exitCodeFor,
  installProcessGuards,
} from "./src/utils/process-guards.js";

// Init Sentry BEFORE the workers start so a crash during worker startup is
// still reported.
initSentry();

startWorkers().catch((err) => {
  logger.error(err, "Failed to start worker");
  process.exit(1);
});

// Minimal liveness surface so the platform (and the Docker HEALTHCHECK) can
// see a wedged-but-alive worker instead of a permanent no-op probe.
// WORKER_HEALTH_PORT=0 disables it.
let healthServer = null;
if (ENV.WORKER_HEALTH_PORT > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(ENV.WORKER_HEALTH_PORT, () => {
    logger.info(`Worker health endpoint on port ${ENV.WORKER_HEALTH_PORT}`);
  });
}

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down workers...`);

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(() => resolve()));
    }
    await stopWorkers();
    // Deferred sends (password-reset email, OTP delivery) were dispatched off
    // the response path; a request already answered 200 must not lose its
    // email to the deploy. Bounded, so a hung provider cannot stall the exit.
    await drainDispatches();
    await closeRedisClient();
    await flushSentry();
    await prisma.$disconnect();
    process.exit(exitCodeFor(signal));
  } catch (error) {
    logger.error(error, "Error during worker shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

installProcessGuards(shutdown);
