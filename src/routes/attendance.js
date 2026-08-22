import { Router } from "express";
const router = Router();

import {
  createAttendance,
  createAttendanceChallenge,
  createAttendanceStepChallenge,
  stepCheckIn,
  stepCheckOut,
  updateAttendance,
  getEventAttendance,
  getUserAttendance,
  getUserEventAttendance,
} from "../controllers/index.js";

import { authorizeRole } from "../middleware/authorize-role.js";
import { authenticateJWT } from "../middleware/jwt-authentication.js";
import { frameUpload } from "../config/multer-setup.js";
import { validateImageUploads } from "../middleware/validate-image-upload.js";
import {
  attendanceAttemptLimiter,
  attendanceStepLimiter,
} from "../middleware/rate-limit.js";
import { LIVENESS } from "../config/constants.js";

// Step 1: fail-fast preflight that mints a randomized liveness challenge.
router.post(
  "/:eventId/challenge",
  authenticateJWT,
  attendanceAttemptLimiter,
  authorizeRole(["USER"]),
  ...createAttendanceChallenge
);

// Step 2: the check-in itself. Frames arrive as multipart files ("frames");
// the server does the face + liveness verification against them.
router.post(
  "/:eventId",
  authenticateJWT,
  attendanceAttemptLimiter,
  authorizeRole(["USER"]),
  frameUpload.array("frames", LIVENESS.MAX_FRAMES),
  validateImageUploads,
  ...createAttendance
);

// Check-out also uploads frames for server-side liveness (multipart).
router.put(
  "/:eventId",
  authenticateJWT,
  attendanceAttemptLimiter,
  authorizeRole(["USER"]),
  frameUpload.array("frames", LIVENESS.MAX_FRAMES),
  validateImageUploads,
  ...updateAttendance
);

// Step-by-step flow. Step 1: preflight + issue a step challenge.
router.post(
  "/:eventId/step-challenge",
  authenticateJWT,
  attendanceAttemptLimiter,
  authorizeRole(["USER"]),
  ...createAttendanceStepChallenge
);

// Per-action uploads: one dense single-action burst verified before the next
// action is prompted. POST advances a check-in, PUT a check-out.
router.post(
  "/:eventId/step",
  authenticateJWT,
  attendanceStepLimiter,
  authorizeRole(["USER"]),
  frameUpload.array("frames", LIVENESS.MAX_STEP_FRAMES),
  validateImageUploads,
  ...stepCheckIn
);

router.put(
  "/:eventId/step",
  authenticateJWT,
  attendanceStepLimiter,
  authorizeRole(["USER"]),
  frameUpload.array("frames", LIVENESS.MAX_STEP_FRAMES),
  validateImageUploads,
  ...stepCheckOut
);

router.get(
  "/users/:userId",
  authenticateJWT,
  authorizeRole(["ADMIN", "USER"]),
  getUserAttendance
);

router.get(
  "/events/:eventId",
  authenticateJWT,
  authorizeRole(["ADMIN"]),
  getEventAttendance
);

router.get(
  "/users/:userId/events/:eventId",
  authenticateJWT,
  authorizeRole(["ADMIN", "USER"]),
  getUserEventAttendance
);

export default router;
