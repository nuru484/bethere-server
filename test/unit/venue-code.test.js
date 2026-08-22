// test/unit/venue-code.test.js
//
// The rotating venue code: stateless, keyed-hash, time-windowed. A current code
// validates, a stale/foreign/wrong-length code does not, and the display batch
// is ordered and consistent with validation.
import { describe, expect, it } from "vitest";
import {
  upcomingCodes,
  isValidVenueCode,
} from "../../src/services/venue-code.service.js";
import { VENUE_CODE } from "../../src/config/constants.js";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("venue-code service", () => {
  it("validates the current code", () => {
    const code = upcomingCodes(SECRET)[0].code;
    expect(isValidVenueCode(SECRET, code)).toBe(true);
  });

  it("rejects a code from a different secret", () => {
    const foreign = upcomingCodes(OTHER)[0].code;
    expect(isValidVenueCode(SECRET, foreign)).toBe(false);
  });

  it("rejects a stale code (older than the skew tolerance)", () => {
    const now = Date.now();
    // A window well outside the accepted skew.
    const stalePast = now - VENUE_CODE.PERIOD_MS * (VENUE_CODE.SKEW_WINDOWS + 5);
    const staleCode = upcomingCodes(SECRET, stalePast, 1)[0].code;
    expect(isValidVenueCode(SECRET, staleCode, now)).toBe(false);
  });

  it("accepts a code within the skew window", () => {
    const now = Date.now();
    const oneWindowAgo = now - VENUE_CODE.PERIOD_MS;
    const recent = upcomingCodes(SECRET, oneWindowAgo, 1)[0].code;
    expect(isValidVenueCode(SECRET, recent, now)).toBe(true);
  });

  it("rejects malformed codes", () => {
    expect(isValidVenueCode(SECRET, "")).toBe(false);
    expect(isValidVenueCode(SECRET, "short")).toBe(false);
    expect(isValidVenueCode(SECRET, null)).toBe(false);
  });

  it("rejects a crafted multibyte code WITHOUT throwing (no 500)", () => {
    // 16 JS chars but 32 UTF-8 bytes: a length-only guard lets this reach
    // timingSafeEqual, which RangeErrors on unequal buffer lengths -> a 500.
    const multibyte = "é".repeat(16);
    expect(() => isValidVenueCode(SECRET, multibyte)).not.toThrow();
    expect(isValidVenueCode(SECRET, multibyte)).toBe(false);
    // Right length, wrong alphabet also fails cleanly.
    expect(isValidVenueCode(SECRET, "z".repeat(16))).toBe(false);
    expect(isValidVenueCode(SECRET, "A".repeat(16))).toBe(false); // uppercase
  });

  it("returns an ordered batch of the requested size", () => {
    const codes = upcomingCodes(SECRET);
    expect(codes).toHaveLength(VENUE_CODE.BATCH_SIZE);
    expect(codes[0].code).not.toBe(codes[1].code);
    expect(new Date(codes[1].validFrom) > new Date(codes[0].validFrom)).toBe(true);
  });
});
