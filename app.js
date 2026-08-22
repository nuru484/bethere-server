// app.js
//
// The Express app, separated from the server bootstrap (server.js) so the
// test suite can drive it through supertest without opening a port or
// starting the BullMQ workers.
import express from "express";
import ENV from "./src/config/env.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import routes from "./src/routes/index.js";
import logger from "./src/utils/logger.js";
import { getRedisClient } from "./src/lib/redis.js";
import { requestId } from "./src/middleware/request-id.js";
import {
  ForbiddenError,
  errorHandler,
  NotFoundError,
} from "./src/middleware/error-handler.js";
import { prisma } from "./src/config/prisma-client.js";
import { initSentry } from "./src/lib/sentry.js";
import { mountApiDocs } from "./src/docs/mount.js";

initSentry();

const app = express();

// FRONTEND_URL is always allowed - it IS the app's own frontend. Building the
// allowlist only from the optional CORS_ACCESS would make a deployment that
// fills in the required vars and leaves that one blank reject every browser
// request from its own client. CORS_ACCESS adds extra origins.
// Trimmed: a comma-separated list is usually written with spaces, and an
// untrimmed " https://b.com" would never match the Origin header; trailing
// slashes are stripped because an Origin header never carries one.
const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, "");
const allowedOrigins = new Set(
  [ENV.FRONTEND_URL, ...(ENV.CORS_ACCESS ? ENV.CORS_ACCESS.split(",") : [])]
    .map(normalizeOrigin)
    .filter(Boolean)
);

const corsOptions = {
  // Auth lives in httpOnly cookies, so cross-origin requests must carry
  // credentials and the origin allowlist does the gating.
  credentials: true,
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      // 403, not 401: cookie clients treat a 401 as "session expired" and
      // refresh or log out - a policy denial for the ORIGIN must not be
      // mistaken for a problem with the caller's credentials.
      callback(
        new ForbiddenError("Not allowed by CORS", {
          code: "CORS_ORIGIN_DENIED",
        })
      );
    }
  },
};

app.use(helmet());
app.use(cors(corsOptions));
// JSON and multipart only - no urlencoded parser. Nothing consumes form
// bodies, and parsing them would let a plain cross-site <form> POST reach
// JSON endpoints if the Origin gate ever weakened.
app.use(express.json());
app.use(cookieParser());
// Env-driven (default: exactly one hop, the platform's load balancer).
// Trusting more hops than actually exist lets clients spoof X-Forwarded-For
// into the IP the rate limiter keys on and the audit trail records.
app.set("trust proxy", ENV.TRUST_PROXY);
app.use(requestId);
if (ENV.NODE_ENV !== "test") {
  // Access logs through the same pino logger as everything else, so
  // production emits ONE format (JSON) and access lines carry the requestId
  // error records reference. Health probes are noise, not traffic.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.requestId,
      autoLogging: {
        ignore: (req) => req.url === "/health" || req.url.startsWith("/health/"),
      },
    })
  );
}

// Liveness: process is up. Kept before the API router so platform pollers
// never touch business middleware.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Deep check: database reachable.
app.get("/health/db", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok", db: "up" });
  } catch {
    res.status(503).json({ status: "error", db: "down" });
  }
});

// Readiness: EVERY hard dependency. Redis matters because the credential
// rate limiters fail closed - with Redis down, login/OTP error while a
// db-only health check stays green.
app.get("/health/ready", async (req, res) => {
  const checks = { db: "up", redis: "up" };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.db = "down";
  }
  try {
    const redis = getRedisClient();
    // Tests run without a shared client; treat "not configured" as ready so
    // the endpoint reports on real dependencies only.
    if (redis) await redis.ping();
  } catch {
    checks.redis = "down";
  }
  const ready = checks.db === "up" && checks.redis === "up";
  res
    .status(ready ? 200 : 503)
    .json({ status: ready ? "ok" : "error", ...checks });
});

// Public API reference. Mounted before the versioned router so the docs are
// reachable without a session, and so a future /api/v1 catch-all can never
// swallow them.
mountApiDocs(app);

app.use("/api/v1", routes);

app.get("/", (req, res, _next) => {
  res.status(200).json({
    success: true,
    message: "API is working",
  });
});

// Unknown route
app.use((req, res, next) => {
  const error = new NotFoundError(`Route ${req.originalUrl} not found`);
  next(error);
});

app.use(errorHandler);

export default app;
