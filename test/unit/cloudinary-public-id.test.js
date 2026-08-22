// test/unit/cloudinary-public-id.test.js
//
// Resolving a stored delivery URL back to the public id `destroy` expects.
// Getting this wrong is silent: Cloudinary answers { result: "not found" }
// with HTTP 200, so a mis-parsed id looks like a successful deletion while
// the biometric frame stays in the account forever.
import { describe, expect, it } from "vitest";
import { extractPublicIdFromUrl } from "../../src/utils/cloudinary.js";

describe("extractPublicIdFromUrl", () => {
  it("parses a plain upload URL", () => {
    expect(
      extractPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/abc.jpg")
    ).toBe("abc");
  });

  it("strips the version prefix", () => {
    expect(
      extractPublicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/v1712345/abc.jpg"
      )
    ).toBe("abc");
  });

  it("strips a signature segment ahead of the version", () => {
    // Stripping only /^v\d+$/ leaves a signed URL as
    // "s--AbC123--/bethere/evidence/abc", which matches no asset.
    expect(
      extractPublicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/s--AbC123_x--/v1712345/bethere/evidence/abc.jpg"
      )
    ).toBe("bethere/evidence/abc");
  });

  it("keeps the full nested folder path", () => {
    expect(
      extractPublicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/v1/bethere/evidence/2026/abc.png"
      )
    ).toBe("bethere/evidence/2026/abc");
  });

  it("parses an authenticated delivery URL", () => {
    expect(
      extractPublicIdFromUrl(
        "https://res.cloudinary.com/demo/image/authenticated/s--Sig--/v1/bethere/evidence/abc.jpg"
      )
    ).toBe("bethere/evidence/abc");
  });

  it("passes a value that is already a public id straight through", () => {
    expect(extractPublicIdFromUrl("bethere/evidence/abc")).toBe(
      "bethere/evidence/abc"
    );
  });
});
