// src/utils/logger.js
import pino from "pino";
import ENV from "../config/env.js";

const isProduction = ENV.NODE_ENV === "production";
const isTest = ENV.NODE_ENV === "test";

// Defense in depth on top of the error handler's sanitizeErrorData: any
// object logged directly (a request, a payload, a principal row) has its
// credential, one-time-code, and biometric fields censored before the log
// stream. Mirrors SENSITIVE_KEY_PARTS in middleware/error-handler.js.
//
// `code` is deliberately redacted only where a REQUEST carries one (the OTP /
// 2FA / venue code in a body or query string). A blanket "*.code" also matches
// err.code and error.code, censoring every Prisma code (P2002, P2025), every
// Node syscall code (ECONNREFUSED) and every Redis/nodemailer code out of
// production logs - the logger.error(error, msg) call sites are exactly where
// those codes are the diagnosis.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "password",
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.confirmPassword",
  "token",
  "*.token",
  "*.refreshToken",
  "*.accessToken",
  "secret",
  "*.secret",
  "*.venueSecret",
  "otp",
  "*.otp",
  "body.code",
  "query.code",
  "params.code",
  "req.body.code",
  "req.query.code",
  "req.params.code",
  "*.venueCode",
  "faceScan",
  "*.faceScan",
  "*.faceScanEnc",
  "*.descriptor",
  "identifier",
  "*.identifier",
];

// JSON logs in production (for log aggregators); pretty-printed in dev only;
// silent in tests (expected 4xx noise buries the actual test output) unless
// LOG_LEVEL explicitly overrides.
const logger = pino({
  level: ENV.LOG_LEVEL ?? (isProduction ? "info" : isTest ? "silent" : "debug"),
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  ...(isProduction || isTest
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: true,
            singleLine: false,
            ignore: "",
          },
        },
      }),
});

export default logger;
