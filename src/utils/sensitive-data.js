// src/utils/sensitive-data.js
//
// The one list of what must never leave the process in a log line or an
// error report, and the two scrubbers built on it: one for structured data
// (keys kept, values masked) and one for free text such as an exception
// message that embeds a "token=..." pair.

/**
 * Substrings that mark a field as sensitive. Beyond the obvious credentials
 * these cover:
 *  - "facescan"/"descriptor": the 128-float biometric template. Logging it
 *    would defeat the AES-256-GCM at-rest encryption it is stored under.
 *  - "code"/"otp": one-time login and 2FA codes, and the rotating venue code
 *    ("venueCode" also matches) - all are live credentials while they last.
 *  - "identifier": the email/phone an OTP was requested for (PII, and pairing
 *    it with a logged code is exactly the combination to keep apart).
 *  - "cookie": the auth cookies on a captured request (headers and the
 *    parsed cookie map alike).
 */
export const SENSITIVE_KEY_PARTS = [
  "password",
  "token",
  "secret",
  "auth",
  "key",
  "credit",
  "ssn",
  "code",
  "otp",
  "facescan",
  "descriptor",
  "identifier",
  "cookie",
];

export const REDACTED = "[REDACTED]";

export const isSensitiveKey = (key) =>
  SENSITIVE_KEY_PARTS.some((part) => key.toLowerCase().includes(part));

/**
 * Deep-copies `data` with every sensitive key's value replaced by the
 * redaction marker. Arrays and nested objects are walked; primitives pass
 * through unchanged.
 */
export const sanitizeErrorData = (data) => {
  if (!data) return data;

  if (Array.isArray(data)) {
    return data.map((entry) => sanitizeErrorData(entry));
  }

  if (typeof data === "object") {
    const sanitized = {};

    Object.entries(data).forEach(([key, value]) => {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED;
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = sanitizeErrorData(value);
      } else {
        sanitized[key] = value;
      }
    });

    return sanitized;
  }

  return data;
};

// "refreshToken=abc", 'password: "hunter2"', "otp=123456": the key and the
// separator survive, the value does not. Stops at whitespace and the usual
// delimiters so the rest of the sentence stays readable.
const SENSITIVE_PAIR_RE = new RegExp(
  `([\\w.-]*(?:${SENSITIVE_KEY_PARTS.join("|")})[\\w.-]*"?\\s*[=:]\\s*)("?)[^\\s,;&"'}\\])]*`,
  "gi"
);

/** Masks the values of sensitive key/value pairs embedded in free text. */
export const maskSensitiveText = (text) => {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(SENSITIVE_PAIR_RE, `$1$2${REDACTED}`);
};
