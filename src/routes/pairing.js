// src/routes/pairing.js
//
// Cross-device "scan from phone" hand-off. Two auth models live here side by
// side: the laptop endpoints are cookie-authenticated (authenticateJWT), and the
// phone endpoints are hand-off-token-authenticated (authenticateHandoff). The
// narrow token therefore only ever reaches these capture routes.
import { Router } from "express";

import {
  startPairing,
  getPairingStatus,
  getPairingContext,
  remoteChallenge,
  remoteCapture,
  remoteStepChallenge,
  remoteStep,
} from "../controllers/index.js";
import { authenticateJWT } from "../middleware/jwt-authentication.js";
import { authenticateHandoff } from "../middleware/authenticate-handoff.js";
import { authorizeRole } from "../middleware/authorize-role.js";
import { frameUpload } from "../config/multer-setup.js";
import { validateImageUploads } from "../middleware/validate-image-upload.js";
import { LIVENESS } from "../config/constants.js";
import {
  pairingStartLimiter,
  pairingPollLimiter,
  attendanceStepLimiter,
} from "../middleware/rate-limit.js";

const router = Router();

// --- Laptop (cookie) ---
router.post(
  "/",
  authenticateJWT,
  pairingStartLimiter,
  authorizeRole(["USER"]),
  startPairing
);

router.get(
  "/:pairingId",
  authenticateJWT,
  pairingPollLimiter,
  authorizeRole(["USER"]),
  getPairingStatus
);

// --- Phone (hand-off token) ---
router.get("/session/context", authenticateHandoff, getPairingContext);

// Batch flow: the phone prompts every challenged action locally (on-device
// gesture detection) and uploads ONE burst proving all of them in order.
router.post(
  "/session/challenge",
  authenticateHandoff,
  pairingStartLimiter,
  remoteChallenge
);

router.post(
  "/session/capture",
  authenticateHandoff,
  attendanceStepLimiter,
  frameUpload.array("frames", LIVENESS.MAX_FRAMES),
  validateImageUploads,
  remoteCapture
);

router.post(
  "/session/step-challenge",
  authenticateHandoff,
  pairingStartLimiter,
  remoteStepChallenge
);

router.post(
  "/session/step",
  authenticateHandoff,
  attendanceStepLimiter,
  frameUpload.array("frames", LIVENESS.MAX_STEP_FRAMES),
  validateImageUploads,
  remoteStep
);

export default router;
