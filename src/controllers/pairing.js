// src/controllers/pairing.js
//
// Thin HTTP adapters for the cross-device "scan from phone" hand-off. The start
// and status endpoints are cookie-authenticated (the laptop); the context and
// capture endpoints are hand-off-token-authenticated (the phone) and REUSE the
// same step services - the event/mode always come from the token (req.handoff),
// never from the client.
import { asyncHandler } from "../middleware/error-handler.js";
import { HTTP_STATUS_CODES } from "../config/constants.js";
import { assertAttendant } from "../utils/authorization.js";
import { framesOrThrow, stepFramesOrThrow } from "../utils/liveness-frames.js";
import * as pairingService from "../services/pairing.service.js";
import * as attendanceService from "../services/attendance.service.js";
import * as faceScanService from "../services/face-scan.service.js";

// Laptop: start a pairing and get the QR token. scope "ATTENDANCE" needs an
// eventId + mode; "ENROLL" needs neither.
export const startPairing = asyncHandler(async (req, res, _next) => {
  assertAttendant(req.user, "Only attendants can start a phone hand-off.");
  const { scope, mode } = req.body;
  const eventId =
    req.body.eventId != null ? Number.parseInt(req.body.eventId, 10) : null;

  const data = await pairingService.startPairing({
    userId: parseInt(req.user.id),
    scope,
    eventId: Number.isNaN(eventId) ? null : eventId,
    mode,
  });

  res.status(HTTP_STATUS_CODES.CREATED).json({
    message: "Scan the code with your phone to continue there.",
    data,
  });
});

// Laptop: poll whether the phone has finished.
export const getPairingStatus = asyncHandler(async (req, res, _next) => {
  assertAttendant(req.user, "Only attendants can view a pairing.");
  const data = await pairingService.getPairingStatus(
    parseInt(req.user.id),
    req.params.pairingId
  );
  res.status(HTTP_STATUS_CODES.OK).json({
    message: "Pairing status.",
    data,
  });
});

// Phone: what capture this pairing is for, so the phone renders the right flow.
export const getPairingContext = asyncHandler(async (req, res, _next) => {
  res.status(HTTP_STATUS_CODES.OK).json({
    message: "Pairing context.",
    data: {
      scope: req.handoff.scope,
      eventId: req.handoff.eventId,
      mode: req.handoff.mode,
    },
  });
});

// Phone, batch flow: mint a batch challenge. The phone prompts every action
// locally and uploads one burst to /session/capture. Dispatches by the
// token's scope; the event/mode are the token's, never the client's.
export const remoteChallenge = asyncHandler(async (req, res, _next) => {
  const userId = parseInt(req.user.id);
  const { scope, eventId, mode } = req.handoff;

  const data =
    scope === "ENROLL"
      ? await faceScanService.prepareEnrollmentChallenge(userId)
      : await attendanceService.prepareAttendanceChallenge(userId, eventId, {
          venueCode: req.body.venueCode,
          mode,
        });

  res.status(HTTP_STATUS_CODES.OK).json({
    message: "Liveness challenge issued. Follow the on-screen actions.",
    data,
  });
});

// Phone, batch flow: one burst proving every challenged action in order.
// Reuses the exact batch services; marks the pairing COMPLETED on success so
// the laptop's poll sees it.
export const remoteCapture = asyncHandler(async (req, res, _next) => {
  const userId = parseInt(req.user.id);
  const { scope, eventId, mode, pairingId } = req.handoff;
  const frameBuffers = framesOrThrow(req.files);

  let result;
  if (scope === "ENROLL") {
    // Multipart fields arrive as strings; the enrollment service wants a real
    // boolean for the consent gate.
    const consent = req.body.consent === true || req.body.consent === "true";
    result = await faceScanService.enrollFaceScan(userId, {
      frameBuffers,
      consent,
      challengeToken: req.body.challengeToken,
      ip: req.ip,
    });
  } else {
    const payload = {
      challengeToken: req.body.challengeToken,
      venueCode: req.body.venueCode,
      frameBuffers,
      ip: req.ip,
    };
    result =
      mode === "out"
        ? { attendance: await attendanceService.checkOut(userId, eventId, payload) }
        : { attendance: await attendanceService.checkIn(userId, eventId, payload) };
  }

  // Best-effort: the capture already committed; a failed flip must not 500.
  await pairingService.completePairing(pairingId).catch(() => undefined);

  res.status(HTTP_STATUS_CODES.OK).json({
    message: "All done. You can return to your laptop.",
    data: { done: true, ...result },
  });
});

// Phone: step 1. Dispatches by the token's scope; the event/mode are the
// token's, never the client's.
export const remoteStepChallenge = asyncHandler(async (req, res, _next) => {
  const userId = parseInt(req.user.id);
  const { scope, eventId, mode } = req.handoff;

  const data =
    scope === "ENROLL"
      ? await faceScanService.prepareEnrollmentStepChallenge(userId)
      : await attendanceService.prepareAttendanceStepChallenge(userId, eventId, {
          venueCode: req.body.venueCode,
          mode,
        });

  res.status(HTTP_STATUS_CODES.OK).json({
    message: "Step-by-step scan started. Perform the first action.",
    data,
  });
});

// Phone: one action per upload. Reuses the exact step services; on the final
// step it marks the pairing COMPLETED so the laptop's poll sees it.
export const remoteStep = asyncHandler(async (req, res, _next) => {
  const userId = parseInt(req.user.id);
  const { scope, eventId, mode, pairingId } = req.handoff;
  const frameBuffers = stepFramesOrThrow(req.files);

  let result;
  if (scope === "ENROLL") {
    // Multipart fields arrive as strings; the enrollment service wants a real
    // boolean for the first-step consent gate.
    const consent = req.body.consent === true || req.body.consent === "true";
    result = await faceScanService.stepEnrollFaceScan(userId, {
      frameBuffers,
      consent,
      challengeToken: req.body.challengeToken,
      ip: req.ip,
    });
  } else {
    const payload = {
      challengeToken: req.body.challengeToken,
      venueCode: req.body.venueCode,
      frameBuffers,
      ip: req.ip,
    };
    result =
      mode === "out"
        ? await attendanceService.stepCheckOut(userId, eventId, payload)
        : await attendanceService.stepCheckIn(userId, eventId, payload);
  }

  if (result.done) {
    // Best-effort: the capture already committed; a failed flip must not 500.
    await pairingService
      .completePairing(pairingId)
      .catch(() => undefined);
  }

  res.status(HTTP_STATUS_CODES.OK).json({
    message: result.done
      ? "All done. You can return to your laptop."
      : "Action verified. Perform the next action.",
    data: result,
  });
});
