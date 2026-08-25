// test/unit/sentry.test.js
//
// Sentry is inert without a DSN, and when configured its environment,
// release and trace sampling come from the env rather than being fixed in
// code. Every event is scrubbed before it leaves the process, and a user is
// only ever identified by an opaque id.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sentryMock, envMock, isolationScope } = vi.hoisted(() => {
  const isolationScope = { setUser: vi.fn(), setTag: vi.fn() };
  return {
    isolationScope,
    sentryMock: {
      init: vi.fn(),
      captureException: vi.fn(),
      flush: vi.fn(async () => true),
      getIsolationScope: vi.fn(() => isolationScope),
      withIsolationScope: vi.fn((fn) => fn(isolationScope)),
    },
    envMock: {
      NODE_ENV: "test",
      SENTRY_DSN: undefined,
      SENTRY_ENVIRONMENT: undefined,
      SENTRY_RELEASE: undefined,
      SENTRY_TRACES_SAMPLE_RATE: 0,
    },
  };
});

vi.mock("@sentry/node", () => sentryMock);
vi.mock("../../src/config/env.js", () => ({ default: envMock }));

async function freshModule() {
  vi.resetModules();
  return import("../../src/lib/sentry.js");
}

const DSN = "https://key@sentry.example/1";

describe("sentry wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.SENTRY_DSN = undefined;
    envMock.SENTRY_ENVIRONMENT = undefined;
    envMock.SENTRY_RELEASE = undefined;
    envMock.SENTRY_TRACES_SAMPLE_RATE = 0;
  });

  it("stays a no-op without SENTRY_DSN", async () => {
    const {
      initSentry,
      captureError,
      flushSentry,
      setSentryUser,
      sentryRequestScope,
    } = await freshModule();
    initSentry();
    captureError(new Error("x"), { source: "test" });
    setSentryUser(42);
    const next = vi.fn();
    sentryRequestScope({ requestId: "r1" }, {}, next);
    await flushSentry();

    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
    expect(sentryMock.withIsolationScope).not.toHaveBeenCalled();
    expect(isolationScope.setUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("initialises with the configured environment, release and sample rate", async () => {
    envMock.SENTRY_DSN = DSN;
    envMock.SENTRY_ENVIRONMENT = "staging";
    envMock.SENTRY_RELEASE = "abc123";
    envMock.SENTRY_TRACES_SAMPLE_RATE = 0.1;
    const { initSentry, flushSentry, scrubEvent } = await freshModule();
    initSentry();
    await flushSentry(1234);

    expect(sentryMock.init).toHaveBeenCalledWith({
      dsn: DSN,
      environment: "staging",
      release: "abc123",
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
    });
    expect(sentryMock.flush).toHaveBeenCalledWith(1234);
  });

  it("falls back to NODE_ENV when SENTRY_ENVIRONMENT is unset", async () => {
    envMock.SENTRY_DSN = DSN;
    const { initSentry } = await freshModule();
    initSentry();

    expect(sentryMock.init.mock.calls[0][0].environment).toBe("test");
    expect(sentryMock.init.mock.calls[0][0].release).toBeUndefined();
  });

  it("scrubs sensitive keys and embedded secrets from an event", async () => {
    const { scrubEvent } = await freshModule();
    const event = scrubEvent({
      message: "login failed for otp=123456",
      extra: { requestId: "r1", body: { password: "pw", eventId: 7 } },
      contexts: { session: { refreshToken: "rt" }, os: { name: "linux" } },
      request: {
        headers: { authorization: "Bearer x", host: "api.test" },
        cookies: { accessToken: "abc" },
        query_string: "code=654321&page=2",
      },
      exception: {
        values: [{ type: "Error", value: 'bad token: "ey.J" for user 9' }],
      },
    });

    expect(event.extra).toEqual({
      requestId: "r1",
      body: { password: "[REDACTED]", eventId: 7 },
    });
    expect(event.contexts).toEqual({
      session: { refreshToken: "[REDACTED]" },
      os: { name: "linux" },
    });
    expect(event.request.headers).toEqual({
      authorization: "[REDACTED]",
      host: "api.test",
    });
    expect(event.request.cookies).toBe("[REDACTED]");
    expect(event.request.query_string).toBe("code=[REDACTED]&page=2");
    expect(event.message).toBe("login failed for otp=[REDACTED]");
    expect(event.exception.values[0].value).toBe(
      'bad token: "[REDACTED]" for user 9'
    );
  });

  it("identifies a request's user by opaque id only, and clears it", async () => {
    envMock.SENTRY_DSN = DSN;
    const { initSentry, setSentryUser, sentryRequestScope } =
      await freshModule();
    initSentry();

    const next = vi.fn();
    sentryRequestScope({ requestId: "r1" }, {}, next);
    expect(sentryMock.withIsolationScope).toHaveBeenCalledTimes(1);
    expect(isolationScope.setUser).toHaveBeenCalledWith(null);
    expect(isolationScope.setTag).toHaveBeenCalledWith("requestId", "r1");
    expect(next).toHaveBeenCalledTimes(1);

    setSentryUser(42);
    expect(isolationScope.setUser).toHaveBeenLastCalledWith({ id: "42" });

    setSentryUser(null);
    expect(isolationScope.setUser).toHaveBeenLastCalledWith(null);
  });

  it("attaches the in-scope request id to captured errors", async () => {
    envMock.SENTRY_DSN = DSN;
    const { initSentry, captureError } = await freshModule();
    const { runWithRequestId } = await import(
      "../../src/lib/request-context.js"
    );
    initSentry();

    const error = new Error("boom");
    runWithRequestId("req-9", () => captureError(error, { queue: "mail" }));

    expect(sentryMock.captureException).toHaveBeenCalledWith(error, {
      extra: { requestId: "req-9", queue: "mail" },
    });
  });
});
