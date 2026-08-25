// test/unit/request-logger.test.js
//
// Log lines written while a request (or a job queued by one) is in scope
// carry its id; outside any request the base logger is used unchanged.
import { describe, expect, it } from "vitest";
import { runWithRequestId } from "../../src/lib/request-context.js";
import logger, { requestLogger } from "../../src/utils/logger.js";

describe("requestLogger", () => {
  it("returns the base logger outside a request", () => {
    expect(requestLogger()).toBe(logger);
  });

  it("returns a child bound to the in-scope request id", () => {
    const child = runWithRequestId("req-42", () => requestLogger());

    expect(child).not.toBe(logger);
    expect(child.bindings()).toEqual({ requestId: "req-42" });
  });

  it("follows the id across awaits", async () => {
    const id = await runWithRequestId("req-async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return requestLogger().bindings().requestId;
    });

    expect(id).toBe("req-async");
  });
});
