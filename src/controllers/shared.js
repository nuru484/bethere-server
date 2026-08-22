// src/controllers/shared.js
//
// Helpers shared across controllers (HTTP layer only - services never
// import from here).
import { HTTP_STATUS_CODES } from "../config/constants.js";
import { paginationMeta } from "../utils/pagination.js";

/**
 * Sends the standard paginated list envelope, switching to the endpoint's
 * empty-state message when there are no rows.
 */
export function sendPage(res, { message, emptyMessage, rows, total, page, limit }) {
  const empty = rows.length === 0;
  res.status(HTTP_STATUS_CODES.OK).json({
    message: empty ? emptyMessage : message,
    data: rows,
    meta: paginationMeta(empty ? 0 : total, page, limit),
  });
}
