// test/unit/logger-redaction.test.js
//
// Every log line passes through pino's redact list, so a request object or
// principal row logged whole cannot leak a credential, a one-time code, a
// biometric template, or a phone number.
import { describe, expect, it } from "vitest";
import pino from "pino";
import { REDACT_PATHS } from "../../src/utils/logger.js";

function logLine(payload) {
  const lines = [];
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    { write: (line) => lines.push(JSON.parse(line)) }
  );
  logger.info(payload);
  return lines[0];
}

describe("logger redaction", () => {
  it("censors request headers that carry credentials", () => {
    const out = logLine({
      req: {
        headers: {
          authorization: "Bearer abc",
          cookie: "accessToken=abc",
          host: "api.test",
        },
      },
      res: { headers: { "set-cookie": ["refreshToken=abc"] } },
    });

    expect(out.req.headers.authorization).toBe("[REDACTED]");
    expect(out.req.headers.cookie).toBe("[REDACTED]");
    expect(out.req.headers.host).toBe("api.test");
    expect(out.res.headers["set-cookie"]).toBe("[REDACTED]");
  });

  it("censors credentials, one-time codes and biometrics in bodies", () => {
    const out = logLine({
      body: {
        password: "pw",
        refreshToken: "rt",
        otp: "123456",
        code: "654321",
        venueSecret: "vs",
        faceScan: [0.42],
        identifier: "user@example.com",
        phone: "233546488115",
      },
    });

    for (const key of Object.keys(out.body)) {
      expect(out.body[key], key).toBe("[REDACTED]");
    }
  });

  it("censors the phone on a principal row but keeps error codes", () => {
    const out = logLine({
      user: { id: 1, phone: "233546488115" },
      err: { code: "P2002", message: "unique" },
    });

    expect(out.user.phone).toBe("[REDACTED]");
    expect(out.user.id).toBe(1);
    expect(out.err.code).toBe("P2002");
  });
});
