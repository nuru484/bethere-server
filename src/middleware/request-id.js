// src/middleware/request-id.js
//
// Correlation id per request: reuse an inbound X-Request-Id from an upstream
// proxy when present, otherwise mint one. Exposed on the response header and on
// req.requestId so the access log, the error log, and the client-visible error
// id all point at the same request.
import crypto from "node:crypto";
import { runWithRequestId } from "../lib/request-context.js";

export function requestId(req, res, next) {
  const inbound = req.headers["x-request-id"];
  const id =
    typeof inbound === "string" && inbound.length > 0 && inbound.length <= 100
      ? inbound
      : crypto.randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  runWithRequestId(id, next);
}
