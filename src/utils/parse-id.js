// src/utils/parse-id.js
//
// The one numeric-id parser for route params, shared by every controller. The
// error message stays caller-supplied so each endpoint keeps naming the id it
// expected ("event ID", "user ID", ...).
import { ValidationError } from "../middleware/error-handler.js";

/** Parses a route-param id, throwing the caller's message when invalid. */
export function parseId(value, message) {
  if (!value || isNaN(parseInt(value))) {
    throw new ValidationError(message);
  }
  return parseInt(value);
}
