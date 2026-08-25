// test/unit/sensitive-data.test.js
//
// Free-text scrubbing for exception messages: a "key=value" or "key: value"
// pair whose key names a credential loses its value and keeps everything
// else readable.
import { describe, expect, it } from "vitest";
import {
  isSensitiveKey,
  maskSensitiveText,
} from "../../src/utils/sensitive-data.js";

describe("maskSensitiveText", () => {
  it("masks values of embedded credential pairs", () => {
    expect(maskSensitiveText("refresh failed: refreshToken=abc.def")).toBe(
      "refresh failed: refreshToken=[REDACTED]"
    );
    expect(maskSensitiveText('login {"password":"hunter2","role":"ADMIN"}')).toBe(
      'login {"password":"[REDACTED]","role":"ADMIN"}'
    );
    expect(maskSensitiveText("otp=123456&identifier=a@b.c")).toBe(
      "otp=[REDACTED]&identifier=[REDACTED]"
    );
  });

  it("leaves text without sensitive pairs untouched", () => {
    const text = "Event 7 not found (status=404)";
    expect(maskSensitiveText(text)).toBe(text);
    expect(maskSensitiveText("")).toBe("");
    expect(maskSensitiveText(undefined)).toBeUndefined();
  });
});

describe("isSensitiveKey", () => {
  it("matches case-insensitively on any fragment", () => {
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("cookies")).toBe(true);
    expect(isSensitiveKey("eventId")).toBe(false);
  });
});
