// test/unit/sentry.test.js
//
// Sentry is inert without a DSN, and when configured its environment and
// trace sampling come from the env rather than being fixed in code.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sentryMock, envMock } = vi.hoisted(() => ({
  sentryMock: {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
  },
  envMock: {
    NODE_ENV: "test",
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: undefined,
    SENTRY_TRACES_SAMPLE_RATE: 0,
  },
}));

vi.mock("@sentry/node", () => sentryMock);
vi.mock("../../src/config/env.js", () => ({ default: envMock }));

async function freshModule() {
  vi.resetModules();
  return import("../../src/lib/sentry.js");
}

describe("sentry wrapper", () => {
  beforeEach(() => {
    sentryMock.init.mockClear();
    sentryMock.captureException.mockClear();
    sentryMock.flush.mockClear();
    envMock.SENTRY_DSN = undefined;
    envMock.SENTRY_ENVIRONMENT = undefined;
    envMock.SENTRY_TRACES_SAMPLE_RATE = 0;
  });

  it("stays a no-op without SENTRY_DSN", async () => {
    const { initSentry, captureError, flushSentry } = await freshModule();
    initSentry();
    captureError(new Error("x"), { source: "test" });
    await flushSentry();

    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("initialises with the configured environment and sample rate", async () => {
    envMock.SENTRY_DSN = "https://key@sentry.example/1";
    envMock.SENTRY_ENVIRONMENT = "staging";
    envMock.SENTRY_TRACES_SAMPLE_RATE = 0.1;
    const { initSentry, flushSentry } = await freshModule();
    initSentry();
    await flushSentry(1234);

    expect(sentryMock.init).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/1",
      environment: "staging",
      tracesSampleRate: 0.1,
    });
    expect(sentryMock.flush).toHaveBeenCalledWith(1234);
  });

  it("falls back to NODE_ENV when SENTRY_ENVIRONMENT is unset", async () => {
    envMock.SENTRY_DSN = "https://key@sentry.example/1";
    const { initSentry } = await freshModule();
    initSentry();

    expect(sentryMock.init.mock.calls[0][0].environment).toBe("test");
  });
});
