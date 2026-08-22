// src/services/attendance.service.js
//
// Check-in and check-out share one trust model: prove PRESENCE (a live,
// rotating venue code scanned at the location) and IDENTITY (server-side face
// liveness against the enrolled template). Both are verified server-side from a
// scanned code and raw uploaded frames - never from a client-computed verdict.
// The flow is two steps: a fail-fast challenge preflight (code + enrollment +
// window) issues a single-use, mode-scoped liveness challenge; the client then
// uploads frames performing the randomized actions.
import { prisma } from "../config/prisma-client.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../middleware/error-handler.js";
import {
  ATTENDANCE_LATE_GRACE_MS,
  BIOMETRIC_CONSENT_VERSION,
  LIVENESS,
  VENUE_CODE,
} from "../config/constants.js";
import { isFaceDescriptor } from "../utils/face-match.js";
import { decryptTemplate } from "../utils/biometric-crypto.js";
import { eventCalendarDay, todayAtEventTime } from "../utils/time-context.js";
import {
  advanceStep,
  consumeChallenge,
  issueChallenge,
  issueStepChallenge,
  loadStepChallenge,
} from "./liveness-challenge.service.js";
import { getLivenessVerifier } from "./liveness/liveness-verifier.js";
import { storeEvidence } from "./attendance-evidence.service.js";
import { flagAnomaly } from "./anomaly.service.js";
import { auditLogWrite, recordAudit } from "./audit.service.js";
import { ensureVenueSecret, isValidVenueCode } from "./venue-code.service.js";
import logger from "../utils/logger.js";

/** Both mutations answer with the session (+event) and a minimal user. */
const ATTENDANCE_INCLUDE = {
  session: {
    include: {
      event: true,
    },
  },
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
};

/** The actor's account; soft-deleted accounts read as absent. */
async function findUserOrThrow(userId) {
  const user = await prisma.user.findFirst({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError(`User with ID ${userId} not found.`);
  }
  return user;
}

/** The event; soft-deleted events read as absent. */
async function findEventOrThrow(eventId) {
  const event = await prisma.event.findFirst({ where: { id: eventId } });
  if (!event) {
    throw new NotFoundError(`Event with ID ${eventId} not found.`);
  }
  return event;
}

/** The session whose date range covers `now`, or null when none is active. */
export async function resolveActiveSession(eventId, now) {
  // The venue's calendar day, not the server's: sessions are date-only rows
  // and the two disagree whenever the host and the venue are in different
  // timezones.
  const currentDate = eventCalendarDay(now);
  return prisma.session.findFirst({
    where: {
      eventId,
      startDate: { lte: currentDate },
      endDate: { gte: currentDate },
    },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Resolves the enrolled template for a user, decrypting the at-rest ciphertext
 * (falling back to the legacy plaintext column during the migration window).
 * Throws when nothing valid is enrolled.
 */
function resolveEnrolledDescriptor(user) {
  // Defense in depth: the preflight already checks this, but check-in/out call
  // straight here, so a stale-consent template is refused on every path.
  assertConsentCurrent(user);

  let enrolled = null;
  if (user.faceScanEnc) {
    try {
      enrolled = decryptTemplate(user.faceScanEnc, { userId: user.id });
    } catch (error) {
      logger.error(error, `Corrupt face template for user ${user.id}`);
      throw new BadRequestError(
        "Your enrolled face could not be read. Please contact an admin to re-enroll."
      );
    }
  } else if (user.faceScan) {
    enrolled = user.faceScan; // Legacy plaintext, pending backfill.
  }

  if (!isFaceDescriptor(enrolled)) {
    throw new BadRequestError(
      "No enrolled face found for your account. Please contact an admin to enroll your face scan."
    );
  }
  return enrolled;
}

/** Cheap enrollment presence check (no decrypt) for the challenge preflight. */
function assertEnrolled(user) {
  if (!user.faceScanEnc && !user.faceScan) {
    throw new BadRequestError(
      "No enrolled face found for your account. Please contact an admin to enroll your face scan."
    );
  }
}

/**
 * The template was enrolled under the biometric-consent notice in force at the
 * time. When that notice materially changes the policy version is bumped, and a
 * template still carrying an older (or absent) version must not keep verifying
 * check-ins under stale consent - GDPR Art. 9 / BIPA consent is specific to
 * what was agreed to. Re-enrollment (admin reset, then the user re-enrolls with
 * the current notice) refreshes it. Enforced as "not equal" rather than a
 * version ordering, because the version string is an opaque policy tag.
 */
function assertConsentCurrent(user) {
  // Gate templates that RECORDED a consent version which no longer matches: a
  // policy-version bump then forces those users to re-consent. A null version
  // is a legacy/plaintext enrollment from before consent-version tracking; it
  // is left to the normal enrollment path rather than locking the user out on
  // the deploy that introduces this check.
  if (
    user.biometricConsentVersion &&
    user.biometricConsentVersion !== BIOMETRIC_CONSENT_VERSION
  ) {
    throw new BadRequestError(
      "Your biometric consent is out of date. Please contact an admin to reset your face scan so you can re-enroll under the current consent notice.",
      { code: "BIOMETRIC_CONSENT_STALE" }
    );
  }
}

/**
 * Tolerance for the venue code when it is RE-checked with the uploaded frames.
 * The code is scanned at the preflight, so it has to remain acceptable for the
 * whole challenge lifetime plus the normal skew - otherwise a user who scanned
 * near the end of a 30s window is told the code expired while they were
 * performing the actions they were just asked to perform.
 */
const UPLOAD_SKEW_WINDOWS =
  VENUE_CODE.SKEW_WINDOWS +
  Math.ceil(LIVENESS.CHALLENGE_TTL_MS / VENUE_CODE.PERIOD_MS);

// The step-by-step flow spans several verified round-trips, so its final commit
// accepts a venue code across the whole step-challenge lifetime plus skew. The
// challenge is single-use and presence was first proven at the preflight, so
// this wider window cannot be relayed and reused.
const STEP_UPLOAD_SKEW_WINDOWS =
  VENUE_CODE.SKEW_WINDOWS +
  Math.ceil(LIVENESS.STEP_CHALLENGE_TTL_MS / VENUE_CODE.PERIOD_MS);

/** Friendly, action-specific retry copy for a failed step. */
function stepFailureMessage(action) {
  switch (action) {
    case "BLINK":
      return "We didn't catch your blink. Look at the camera and blink clearly, then try this step again.";
    case "SMILE":
      return "We didn't catch your smile. Smile clearly at the camera, then try this step again.";
    case "TURN_LEFT":
      return "We didn't catch you turning left. Turn your head clearly to the side, then try this step again.";
    case "TURN_RIGHT":
      return "We didn't catch you turning right. Turn your head clearly to the side, then try this step again.";
    default:
      return "We couldn't verify that action. Follow the on-screen prompt and try this step again.";
  }
}

/**
 * Records a failed step attempt the same way a failed batch attempt is recorded
 * (flagged evidence + anomaly + audit), so the integrity dashboards see step
 * failures too. Never throws - a bookkeeping failure must not mask the step
 * result the caller is about to return.
 */
async function recordStepFailure({
  userId,
  eventId,
  action,
  verdict,
  frameBuffers,
  ip,
  auditAction,
}) {
  // PII-safe diagnostics (signal aggregates, no biometrics) so a real-world
  // false reject can be seen and the thresholds calibrated against actual output.
  logger.warn(
    { action, reasons: verdict.reasons, signals: verdict.signals },
    "Liveness step not satisfied"
  );

  const replaySuspected = verdict.reasons?.includes("replay_suspected") ?? false;
  const evidence = await storeEvidence({
    userId,
    eventId,
    frameBuffers,
    livenessScore: verdict.score ?? null,
    matchDistance: verdict.matchDistance ?? null,
    reason: verdict.reasons?.join(",") ?? "",
  }).catch((error) => {
    logger.error(error, "Failed to store step-failure evidence");
    return null;
  });

  await flagAnomaly({
    userId,
    eventId,
    type: replaySuspected ? "REPLAY_SUSPECTED" : "LIVENESS_FAILED",
    severity: replaySuspected ? "HIGH" : "MEDIUM",
    detail: { action, step: true, reasons: verdict.reasons },
    evidenceId: evidence?.id ?? null,
  }).catch((error) => logger.error(error, "Failed to flag step anomaly"));

  await recordAudit({
    actorKind: "USER",
    actorId: userId,
    action: auditAction,
    targetType: "Event",
    targetId: eventId,
    metadata: { action, reasons: verdict.reasons, step: true },
    ip,
  }).catch((error) => logger.error(error, "Failed to audit step failure"));
}

/** Validates the scanned rotating venue code against the event's secret. */
async function assertValidVenueCode(eventId, venueCode, { skewWindows } = {}) {
  const secret = await ensureVenueSecret(eventId);
  if (!secret) {
    throw new NotFoundError(`Event with ID ${eventId} not found.`);
  }
  if (!isValidVenueCode(secret, venueCode, Date.now(), skewWindows)) {
    throw new BadRequestError(
      "Invalid or expired venue code. Please scan the code shown at the event location."
    );
  }
}

/**
 * Enforces the active session + daily window (venue timezone), returning the
 * session and the PRESENT/LATE status. Shared cheap gate before the ML step.
 */
async function resolveSessionForCheckIn(event, now) {
  const currentSession = await resolveActiveSession(event.id, now);

  if (!currentSession) {
    throw new BadRequestError(
      "No active session for this event at the moment. Please wait for the next session to check in."
    );
  }

  const sessionStartTime = todayAtEventTime(event.startTime, now);
  const sessionEndTime = todayAtEventTime(event.endTime, now);

  if (now < sessionStartTime) {
    throw new BadRequestError(
      `Check-in is not yet open. Please check in after ${event.startTime}.`
    );
  }
  if (now > sessionEndTime) {
    throw new BadRequestError(
      `Check-in is closed for today. The check-in window was ${event.startTime} - ${event.endTime}.`
    );
  }

  const presentUntil = new Date(
    sessionStartTime.getTime() + ATTENDANCE_LATE_GRACE_MS
  );
  const status = now <= presentUntil ? "PRESENT" : "LATE";

  return { currentSession, status };
}

/**
 * Runs server-side liveness and throws on failure, recording the failed
 * attempt as flagged evidence + an anomaly + an audit entry. Shared by both
 * check-in and check-out. Returns the verdict on success.
 */
async function runLivenessOrThrow({ userId, eventId, enrolled, actions, frameBuffers, ip, action }) {
  const verdict = await getLivenessVerifier().verify({
    frameBuffers,
    enrolledDescriptor: enrolled,
    actions,
  });

  if (!verdict.passed) {
    const anomalyType = verdict.replaySuspected
      ? "REPLAY_SUSPECTED"
      : "LIVENESS_FAILED";
    const evidence = await storeEvidence({
      userId,
      eventId,
      frameBuffers,
      livenessScore: verdict.score,
      matchDistance: verdict.matchDistance,
      reason: verdict.reasons.join(","),
    }).catch((error) => {
      logger.error(error, "Failed to store liveness-failure evidence");
      return null;
    });

    await flagAnomaly({
      userId,
      eventId,
      type: anomalyType,
      severity: verdict.replaySuspected ? "HIGH" : "MEDIUM",
      detail: { action, reasons: verdict.reasons, failedActions: verdict.failedActions },
      evidenceId: evidence?.id ?? null,
    });

    await recordAudit({
      actorKind: "USER",
      actorId: userId,
      action: `${action}_LIVENESS_FAILED`,
      targetType: "Event",
      targetId: eventId,
      metadata: { reasons: verdict.reasons },
      ip,
    });

    throw new UnauthorizedError(
      "Face verification failed. Please make sure you are in good lighting and follow the on-screen actions, then try again."
    );
  }

  return verdict;
}

/**
 * Step 1 (both directions): the fail-fast preflight. Validates the scanned
 * venue code, enrollment, the session window, and the mode-specific attendance
 * state - BEFORE issuing a challenge or spending any ML. Returns the randomized
 * actions + signed, mode-scoped challenge token.
 */
async function assertAttendancePreflight(userId, eventId, { venueCode, mode }) {
  const user = await findUserOrThrow(userId);
  assertEnrolled(user);
  assertConsentCurrent(user);

  // Tight tolerance here: this IS the moment the code is scanned.
  await assertValidVenueCode(eventId, venueCode);

  const event = await findEventOrThrow(eventId);
  const now = new Date();
  const { currentSession } = await resolveSessionForCheckIn(event, now);

  const existing = await prisma.attendance.findUnique({
    where: { userId_sessionId: { userId, sessionId: currentSession.id } },
  });

  if (mode === "out") {
    if (!existing) {
      throw new NotFoundError(
        "No check-in found for this session. You must check in before checking out."
      );
    }
    if (existing.checkOutTime) {
      throw new ConflictError("You have already checked out of this session.");
    }
  } else if (existing) {
    throw new ConflictError("You have already checked in for this session.");
  }
}

export async function prepareAttendanceChallenge(
  userId,
  eventId,
  { venueCode, mode = "in" }
) {
  await assertAttendancePreflight(userId, eventId, { venueCode, mode });
  return issueChallenge({ userId, eventId, mode });
}

/**
 * Step-by-step variant of the preflight: identical gates, but issues a
 * step-by-step challenge the client proves one action at a time.
 */
export async function prepareAttendanceStepChallenge(
  userId,
  eventId,
  { venueCode, mode = "in" }
) {
  await assertAttendancePreflight(userId, eventId, { venueCode, mode });
  return issueStepChallenge({ userId, eventId, mode });
}

/**
 * Step 2, check-in: consumes the check-in challenge, verifies liveness against
 * the enrolled template, and records PRESENT/LATE. A failed attempt is recorded
 * as evidence + an anomaly, not silently dropped.
 */
export async function checkIn(
  userId,
  eventId,
  { frameBuffers, challengeToken, venueCode, ip }
) {
  const user = await findUserOrThrow(userId);
  const enrolled = resolveEnrolledDescriptor(user);

  // Presence is re-proven HERE, not only at the preflight. Checking it once,
  // when the challenge is minted, would let a code be photographed, relayed
  // off-site, and the frames uploaded from anywhere for the life of the
  // challenge. Codes rotate every 30s, so requiring a still-valid one at
  // upload keeps the proof of presence attached to the proof of liveness.
  await assertValidVenueCode(eventId, venueCode, {
    skewWindows: UPLOAD_SKEW_WINDOWS,
  });

  const event = await findEventOrThrow(eventId);
  const now = new Date();
  const { currentSession, status } = await resolveSessionForCheckIn(event, now);

  const existingAttendance = await prisma.attendance.findUnique({
    where: { userId_sessionId: { userId, sessionId: currentSession.id } },
  });
  if (existingAttendance) {
    throw new ConflictError("You have already checked in for this session.");
  }

  const { actions } = await consumeChallenge({
    token: challengeToken,
    userId,
    eventId,
    mode: "in",
  });

  const verdict = await runLivenessOrThrow({
    userId,
    eventId,
    enrolled,
    actions,
    frameBuffers,
    ip,
    action: "CHECK_IN",
  });

  // One transaction: the attendance row, the biometric last-use stamp, and
  // the audit entry commit together - a crash mid-sequence must not leave a
  // check-in without its audit trail (this IS the audit product).
  const [attendance] = await prisma.$transaction([
    prisma.attendance.create({
      data: { userId, sessionId: currentSession.id, checkInTime: now, status },
      include: ATTENDANCE_INCLUDE,
    }),
    prisma.user.update({
      where: { id: userId },
      data: { faceLastUsedAt: now },
    }),
    auditLogWrite({
      actorKind: "USER",
      actorId: userId,
      action: "CHECK_IN",
      targetType: "Event",
      targetId: eventId,
      metadata: { status, sessionId: currentSession.id, livenessScore: verdict.score },
      ip,
    }),
  ]);

  return attendance;
}

/**
 * Step 2, check-out: consumes the check-out challenge, verifies liveness (same
 * as check-in), and stamps the check-out time within the window.
 */
export async function checkOut(
  userId,
  eventId,
  { frameBuffers, challengeToken, venueCode, ip }
) {
  const user = await findUserOrThrow(userId);
  const enrolled = resolveEnrolledDescriptor(user);

  // Check-out re-proves presence exactly like check-in.
  await assertValidVenueCode(eventId, venueCode, {
    skewWindows: UPLOAD_SKEW_WINDOWS,
  });

  const event = await findEventOrThrow(eventId);
  const now = new Date();

  const currentSession = await resolveActiveSession(eventId, now);
  if (!currentSession) {
    throw new NotFoundError(
      "No active session found for this event at the moment."
    );
  }

  const existingAttendance = await prisma.attendance.findUnique({
    where: { userId_sessionId: { userId, sessionId: currentSession.id } },
  });

  if (!existingAttendance) {
    throw new NotFoundError(
      "No attendance record found. You must check in to the event first."
    );
  }
  if (existingAttendance.checkOutTime) {
    throw new ConflictError("You have already checked out of this session.");
  }

  const sessionEndTime = todayAtEventTime(event.endTime, now);
  if (now > sessionEndTime) {
    throw new BadRequestError(
      `Check-out window has closed. The check-out deadline was ${event.endTime}.`
    );
  }
  if (now <= existingAttendance.checkInTime) {
    throw new BadRequestError("Check-out time must be after check-in time.");
  }

  const { actions } = await consumeChallenge({
    token: challengeToken,
    userId,
    eventId,
    mode: "out",
  });

  await runLivenessOrThrow({
    userId,
    eventId,
    enrolled,
    actions,
    frameBuffers,
    ip,
    action: "CHECK_OUT",
  });

  // Same atomicity as check-in: the stamp and its audit entry land together.
  const [updated] = await prisma.$transaction([
    prisma.attendance.update({
      where: { userId_sessionId: { userId, sessionId: currentSession.id } },
      data: { checkOutTime: now },
      include: ATTENDANCE_INCLUDE,
    }),
    auditLogWrite({
      actorKind: "USER",
      actorId: userId,
      action: "CHECK_OUT",
      targetType: "Event",
      targetId: eventId,
      metadata: { sessionId: currentSession.id },
      ip,
    }),
  ]);

  return updated;
}

/**
 * Verifies ONE action of a step-by-step check-in or check-out. The client
 * uploads a dense single-action burst; the server proves just actions[step],
 * advances the challenge, and reports the next action - or, on the final step,
 * re-proves presence and commits the attendance record. A failed step does NOT
 * advance, so the user keeps being shown that same action until they perform it.
 */
async function verifyAttendanceStep(userId, eventId, mode, payload) {
  const { frameBuffers, challengeToken, venueCode, ip } = payload;
  const user = await findUserOrThrow(userId);
  const enrolled = resolveEnrolledDescriptor(user);

  const { nonce, actions, currentStep, state } = await loadStepChallenge({
    token: challengeToken,
    userId,
    eventId,
    mode,
  });

  if (currentStep >= actions.length) {
    throw new ConflictError("This scan is already complete.");
  }

  const action = actions[currentStep];
  const isLast = currentStep === actions.length - 1;
  const auditKind = mode === "out" ? "CHECK_OUT" : "CHECK_IN";
  const now = new Date();

  // Presence + attendance-state are re-proven only at the FINAL commit: the step
  // token authenticates the intermediate steps, and re-anchoring presence to the
  // moment of the write keeps a relayed code from ever producing a record.
  let event;
  let currentSession;
  let status;
  let existingAttendance;
  if (isLast) {
    await assertValidVenueCode(eventId, venueCode, {
      skewWindows: STEP_UPLOAD_SKEW_WINDOWS,
    });
    event = await findEventOrThrow(eventId);

    if (mode === "out") {
      currentSession = await resolveActiveSession(eventId, now);
      if (!currentSession) {
        throw new NotFoundError(
          "No active session found for this event at the moment."
        );
      }
      existingAttendance = await prisma.attendance.findUnique({
        where: { userId_sessionId: { userId, sessionId: currentSession.id } },
      });
      if (!existingAttendance) {
        throw new NotFoundError(
          "No attendance record found. You must check in to the event first."
        );
      }
      if (existingAttendance.checkOutTime) {
        throw new ConflictError("You have already checked out of this session.");
      }
      const sessionEndTime = todayAtEventTime(event.endTime, now);
      if (now > sessionEndTime) {
        throw new BadRequestError(
          `Check-out window has closed. The check-out deadline was ${event.endTime}.`
        );
      }
      if (now <= existingAttendance.checkInTime) {
        throw new BadRequestError("Check-out time must be after check-in time.");
      }
    } else {
      ({ currentSession, status } = await resolveSessionForCheckIn(event, now));
      existingAttendance = await prisma.attendance.findUnique({
        where: { userId_sessionId: { userId, sessionId: currentSession.id } },
      });
      if (existingAttendance) {
        throw new ConflictError("You have already checked in for this session.");
      }
    }
  }

  const verdict = await getLivenessVerifier().verifyAction({
    frameBuffers,
    enrolledDescriptor: enrolled,
    action,
    firstTurnSign: state.firstTurnSign,
  });

  if (!verdict.passed) {
    await recordStepFailure({
      userId,
      eventId,
      action,
      verdict,
      frameBuffers,
      ip,
      auditAction: `${auditKind}_STEP_FAILED`,
    });
    throw new UnauthorizedError(stepFailureMessage(action), {
      code: "STEP_FAILED",
      context: { action, reasons: verdict.reasons },
    });
  }

  // Check-in identity is proven against the enrolled template on every step, so
  // only the first turn's SIGN needs to survive across steps (for the reversal
  // check on a two-turn challenge).
  const newState = {
    descriptors: state.descriptors,
    firstTurnSign: state.firstTurnSign ?? verdict.turnSign ?? null,
  };

  const advanced = await advanceStep({
    nonce,
    userId,
    fromStep: currentStep,
    state: newState,
    done: isLast,
  });
  if (!advanced) {
    throw new ConflictError(
      "That action was already recorded. Please continue with the next step."
    );
  }

  if (!isLast) {
    return {
      done: false,
      currentStep: currentStep + 1,
      nextAction: actions[currentStep + 1],
      totalSteps: actions.length,
    };
  }

  // Final step passed: commit the record + its audit entry atomically.
  if (mode === "out") {
    const [updated] = await prisma.$transaction([
      prisma.attendance.update({
        where: { userId_sessionId: { userId, sessionId: currentSession.id } },
        data: { checkOutTime: now },
        include: ATTENDANCE_INCLUDE,
      }),
      auditLogWrite({
        actorKind: "USER",
        actorId: userId,
        action: "CHECK_OUT",
        targetType: "Event",
        targetId: eventId,
        metadata: { sessionId: currentSession.id, stepwise: true },
        ip,
      }),
    ]);
    return { done: true, attendance: updated };
  }

  const [attendance] = await prisma.$transaction([
    prisma.attendance.create({
      data: { userId, sessionId: currentSession.id, checkInTime: now, status },
      include: ATTENDANCE_INCLUDE,
    }),
    prisma.user.update({
      where: { id: userId },
      data: { faceLastUsedAt: now },
    }),
    auditLogWrite({
      actorKind: "USER",
      actorId: userId,
      action: "CHECK_IN",
      targetType: "Event",
      targetId: eventId,
      metadata: { status, sessionId: currentSession.id, stepwise: true },
      ip,
    }),
  ]);
  return { done: true, attendance };
}

export function stepCheckIn(userId, eventId, payload) {
  return verifyAttendanceStep(userId, eventId, "in", payload);
}

export function stepCheckOut(userId, eventId, payload) {
  return verifyAttendanceStep(userId, eventId, "out", payload);
}
