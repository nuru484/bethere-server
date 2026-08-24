// test/unit/process-guards.test.js
//
// A crash the platform restarts is only useful if the tracker saw it first:
// the process-level handlers must report, flush, and only then hand off to
// the shutdown path.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureError, flushSentry, order } = vi.hoisted(() => {
  const order = [];
  return {
    order,
    captureError: vi.fn(() => order.push("capture")),
    flushSentry: vi.fn(async () => order.push("flush")),
  };
});

vi.mock("../../src/lib/sentry.js", () => ({ captureError, flushSentry }));
vi.mock("../../src/utils/logger.js", () => ({
  default: { error: vi.fn(), fatal: vi.fn() },
}));

const { installProcessGuards } = await import(
  "../../src/utils/process-guards.js"
);

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe("installProcessGuards", () => {
  beforeEach(() => {
    order.length = 0;
    captureError.mockClear();
    flushSentry.mockClear();
  });

  it("reports an uncaught exception, flushes, then shuts down", async () => {
    const target = new EventEmitter();
    const shutdown = vi.fn(async () => order.push("shutdown"));
    installProcessGuards(shutdown, { target });

    const boom = new Error("boom");
    target.emit("uncaughtException", boom);
    await flushMicrotasks();

    expect(captureError).toHaveBeenCalledWith(boom, {
      source: "uncaughtException",
    });
    expect(shutdown).toHaveBeenCalledWith("uncaughtException");
    expect(order).toEqual(["capture", "flush", "shutdown"]);
  });

  it("wraps a non-Error rejection reason and shuts down", async () => {
    const target = new EventEmitter();
    const shutdown = vi.fn(async () => order.push("shutdown"));
    installProcessGuards(shutdown, { target });

    target.emit("unhandledRejection", "plain string reason");
    await flushMicrotasks();

    const [reported, context] = captureError.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe("plain string reason");
    expect(context).toEqual({ source: "unhandledRejection" });
    expect(shutdown).toHaveBeenCalledWith("unhandledRejection");
    expect(order).toEqual(["capture", "flush", "shutdown"]);
  });
});

describe("exitCodeFor", () => {
  it("is 0 for a signal and 1 for a crash source", async () => {
    const { exitCodeFor } = await import("../../src/utils/process-guards.js");
    expect(exitCodeFor("SIGTERM")).toBe(0);
    expect(exitCodeFor("SIGINT")).toBe(0);
    expect(exitCodeFor("uncaughtException")).toBe(1);
    expect(exitCodeFor("unhandledRejection")).toBe(1);
  });
});
