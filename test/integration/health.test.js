// test/integration/health.test.js
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";

describe("health endpoints", () => {
  it("GET /health answers 200 without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /health/db verifies database connectivity", async () => {
    const res = await request(app).get("/health/db");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("up");
  });

  it("stamps every response with an X-Request-Id and echoes it in errors", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeTruthy();

    // An error response carries the same correlation id in the body.
    const missing = await request(app).get("/api/v1/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.requestId).toBe(missing.headers["x-request-id"]);
  });

  it("reuses an inbound X-Request-Id", async () => {
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", "upstream-correlation-123");
    expect(res.headers["x-request-id"]).toBe("upstream-correlation-123");
  });
});

describe("readiness", () => {
  it("GET /ready answers 200 when every dependency is up", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "up", redis: "up" });
  });

  it("GET /ready answers 503 when the database is down", async () => {
    const query = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "error", db: "down" });
    query.mockRestore();
  });
});
