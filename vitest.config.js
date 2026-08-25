// vitest.config.js
//
// Integration-test runner: tests hit the real Express app (supertest) against
// a dedicated bethere_test database that global-setup creates and migrates.
// Required env vars are derived from .env when present (local runs) or from
// the process env (CI), with the database name swapped so the dev database is
// never touched.
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/** Minimal .env parser - avoids a dotenv dependency for tests only. */
function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const entries = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    // Strip a single pair of surrounding quotes, mirroring how node
    // --env-file and dotenv read the same .env (e.g. DATABASE_URL="...").
    let value = match[2];
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.at(-1) === value[0]
    ) {
      value = value.slice(1, -1);
    }
    entries[match[1]] = value;
  }
  return entries;
}

const fileEnv = parseEnvFile(path.join(import.meta.dirname, ".env"));
const get = (name, fallback) =>
  process.env[name] ?? fileEnv[name] ?? fallback;

const baseDatabaseUrl = get("DATABASE_URL");
if (!baseDatabaseUrl) {
  throw new Error("DATABASE_URL is required (env or .env) to run the tests");
}
const url = new URL(baseDatabaseUrl);
url.pathname = "/bethere_test";
const testDatabaseUrl = url.toString();

// globalSetup runs in this same process; the test.env block below only
// reaches the test workers. REDIS_URL is exposed the same way so the
// global-setup preflight can ping it.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.REDIS_URL = get("REDIS_URL", "redis://localhost:6379");

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.js"],
    setupFiles: ["./test/setup.js"],
    // One worker, serial files: every test truncates the shared test DB.
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.js", "app.js", "server.js", "worker.js"],
      reporter: ["text", "html"],
      // Floors hold the current level so a change cannot quietly shed tests.
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 80,
        branches: 65,
      },
    },
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      REDIS_URL: get("REDIS_URL", "redis://localhost:6379"),
      ACCESS_TOKEN_SECRET: "test-access-secret",
      REFRESH_TOKEN_SECRET: "test-refresh-secret",
      ADMIN_EMAIL: "admin@test.local",
      ADMIN_PASSWORD: "test-admin-password",
      ADMIN_FIRSTNAME: "Test",
      ADMIN_LASTNAME: "Admin",
      CLOUDINARY_CLOUD_NAME: "test",
      CLOUDINARY_API_KEY: "test",
      CLOUDINARY_API_SECRET: "test",
      FRONTEND_URL: "http://localhost:5173",
      SMTP_HOST: "localhost",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      GMAIL_USER: "test@test.local",
      GMAIL_PASSWORD: "test",
      // A fixed 32-byte key so template encryption works in tests. Liveness
      // ML is disabled so the suite never loads the face models.
      FACE_TEMPLATE_ENC_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      LIVENESS_ENABLED: "false",
    },
  },
});
