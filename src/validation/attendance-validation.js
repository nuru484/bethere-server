import { body } from "express-validator";

const venueCodeRule = body("venueCode")
  .exists({ checkFalsy: true })
  .withMessage("Please scan the venue code shown at the event location.")
  .isString()
  .withMessage("Invalid venue code.");

const challengeTokenRule = body("challengeToken")
  .exists({ checkFalsy: true })
  .withMessage("A liveness challenge token is required.")
  .isString()
  .withMessage("Invalid challenge token.");

// Step 1 (both directions): the fail-fast preflight that issues a liveness
// challenge. Presence is proven by the scanned rotating venue code, not by a
// geofence. `mode` selects check-in vs check-out.
export const createChallengeValidation = [
  venueCodeRule,
  body("mode")
    .optional()
    .isIn(["in", "out"])
    .withMessage("mode must be 'in' or 'out'."),
];

// Step 2: check-in. Frames arrive as multipart files (validated in the
// controller); verification is entirely server-side, so there is no
// client-computed descriptor. The venue code is re-sent and re-checked here,
// so presence has to still hold when the frames are uploaded, not only when
// the challenge was minted.
export const createAttendanceValidation = [challengeTokenRule, venueCodeRule];

// Step 2: check-out. Same shape as check-in - it also uploads frames, runs
// server-side liveness, and re-proves presence.
export const updateAttendanceValidation = [challengeTokenRule, venueCodeRule];

// Step-by-step: each per-action upload carries the step token and the venue
// code (re-checked at the final step). The server is authoritative on which
// step this is, so no step index is trusted from the client.
export const attendanceStepValidation = [challengeTokenRule, venueCodeRule];
