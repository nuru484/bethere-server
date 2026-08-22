// src/services/face-scan.service.js
//
// Face template enrollment lifecycle. Two compliance rules live here:
//  1. CONSENT: enrollment is refused without explicit biometric consent
//     (GDPR Art. 9 / BIPA); the consent timestamp + policy version are stored.
//  2. AT-REST ENCRYPTION: the 128-float template is AES-256-GCM encrypted
//     before it touches the database and is decrypted only in memory at match
//     time. The raw descriptor is never returned to any client.
import { prisma } from "../config/prisma-client.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../middleware/error-handler.js";
import ENV from "../config/env.js";
import { assertSelfOrAdmin } from "../utils/authorization.js";
import { decryptTemplate, encryptTemplate } from "../utils/biometric-crypto.js";
import { euclideanDistance, isFaceDescriptor } from "../utils/face-match.js";
import { BIOMETRIC_CONSENT_VERSION } from "../config/constants.js";
import { flagAnomaly } from "./anomaly.service.js";
import { recordAudit } from "./audit.service.js";
import logger from "../utils/logger.js";
import { KIND_USER, toSafeUser } from "./auth.service.js";
import {
  advanceStep,
  issueChallenge,
  issueStepChallenge,
  loadStepChallenge,
  consumeChallenge,
} from "./liveness-challenge.service.js";
import { getEnrollmentVerifier } from "./liveness/liveness-verifier.js";
import { finalizeEnrollment } from "./liveness/evaluate.js";

const hasEnrollment = (user) => Boolean(user.faceScanEnc || user.faceScan);

/** How many encrypted templates one duplicate-scan batch decrypts. */
const DUPLICATE_SCAN_BATCH = 200;

/**
 * The classic buddy-punching vector: the same face enrolled under a second
 * account. Scans every OTHER user's stored template against the new
 * descriptor (in bounded batches, decrypting in memory only) and throws 409
 * when one matches within the face-match threshold, flagging a
 * DUPLICATE_DESCRIPTOR anomaly for review.
 */
async function assertDescriptorNotEnrolledElsewhere(userId, descriptor, ip) {
  let cursor;

  for (;;) {
    const batch = await prisma.user.findMany({
      where: { id: { not: userId }, faceScanEnc: { not: null } },
      select: { id: true, faceScanEnc: true },
      orderBy: { id: "asc" },
      take: DUPLICATE_SCAN_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) return;

    for (const other of batch) {
      let enrolled;
      try {
        enrolled = decryptTemplate(other.faceScanEnc, { userId: other.id });
      } catch (error) {
        // A corrupt template cannot match anything; skip it.
        logger.error(error, `Corrupt face template for user ${other.id}`);
        continue;
      }
      if (!isFaceDescriptor(enrolled)) continue;

      if (euclideanDistance(descriptor, enrolled) <= ENV.FACE_MATCH_THRESHOLD) {
        await flagAnomaly({
          userId,
          type: "DUPLICATE_DESCRIPTOR",
          severity: "HIGH",
          detail: { matchedUserId: other.id },
        });
        await recordAudit({
          actorKind: "USER",
          actorId: userId,
          action: "FACE_ENROLL_DUPLICATE",
          targetType: "User",
          targetId: userId,
          metadata: { matchedUserId: other.id },
          ip,
        });
        throw new ConflictError(
          "This face appears to be enrolled on another account already. Please contact an admin."
        );
      }
    }

    if (batch.length < DUPLICATE_SCAN_BATCH) return;
    cursor = batch[batch.length - 1].id;
  }
}

/** Challenge mode tag: keeps an enrollment challenge from ever driving a
 * check-in (and vice versa) even though both use the same token format. */
const ENROLL_MODE = "enroll";

/**
 * Step 1 of enrollment: a randomized liveness challenge, exactly like check-in.
 * Refused when a template already exists, so the expensive capture is never
 * started for a user who would be rejected at the end.
 */
export async function prepareEnrollmentChallenge(userId) {
  const user = await prisma.user.findFirst({ where: { id: userId } });

  if (!user) {
    throw new NotFoundError("User not found.");
  }

  if (hasEnrollment(user)) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }

  return issueChallenge({ userId, eventId: null, mode: ENROLL_MODE });
}

/**
 * Step 2: one-time enrollment FROM IMAGES. The server runs the face engine
 * over the uploaded frames, proves the challenge actions were performed live,
 * and derives the template itself.
 *
 * A descriptor computed in the browser is never accepted: the server would
 * not see a face at the moment identity is established, and a template built
 * from a photograph of somebody else would be indistinguishable from a real
 * enrollment. Everything downstream (matching, evidence, anomalies) trusts
 * this template, so it has to be produced server-side.
 */
export async function enrollFaceScan(
  userId,
  { frameBuffers, consent, challengeToken, ip } = {}
) {
  const user = await prisma.user.findFirst({ where: { id: userId } });

  if (!user) {
    throw new NotFoundError("User not found.");
  }

  if (consent !== true) {
    throw new BadRequestError(
      "Biometric consent is required before enrolling your face."
    );
  }

  if (hasEnrollment(user)) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }

  // Single-use: a replayed token cannot re-drive an enrollment.
  const { actions } = await consumeChallenge({
    token: challengeToken,
    userId,
    eventId: null,
    mode: ENROLL_MODE,
  });

  const verdict = await getEnrollmentVerifier().enroll({
    frameBuffers,
    actions,
    userId,
  });

  if (!verdict.passed || !isFaceDescriptor(verdict.descriptor)) {
    await recordAudit({
      actorKind: "USER",
      actorId: userId,
      action: "FACE_ENROLL_FAILED",
      targetType: "User",
      targetId: userId,
      metadata: {
        reasons: verdict.reasons,
        failedActions: verdict.failedActions,
      },
      ip,
    });

    // CustomError only reads layer/severity/code/context from its options, so
    // the diagnostics must ride under `context` or they are silently dropped.
    throw new BadRequestError(
      "We could not verify a live face in that capture. Please follow the prompts in order and try again.",
      {
        context: {
          reasons: verdict.reasons,
          failedActions: verdict.failedActions,
        },
      }
    );
  }

  // Refuse a template that already belongs to another account (buddy
  // punching by double-enrollment). Runs AFTER liveness passed, so the cost
  // is only paid for captures that would otherwise enroll.
  await assertDescriptorNotEnrolledElsewhere(userId, verdict.descriptor, ip);

  // GUARDED write, not a plain update. The hasEnrollment check above happens
  // seconds earlier - a whole face-engine pass earlier - so two captures
  // started in two tabs would both pass it and the second, which could be a
  // different person's face, would silently overwrite the first. Asserting the
  // template is still empty makes "one enrollment until an admin resets it"
  // actually hold.
  // Guarded on faceScanEnc only: `faceScan` is a Json? column and Prisma
  // rejects a bare null filter on JSON (it needs DbNull/JsonNull). A legacy
  // plaintext enrollment is already refused by the hasEnrollment read above,
  // and the race this closes is between two NEW enrollments, which both have
  // faceScanEnc null.
  const claimed = await prisma.user.updateMany({
    where: { id: userId, faceScanEnc: null },
    data: {
      faceScanEnc: encryptTemplate(verdict.descriptor, { userId }),
      biometricConsentAt: new Date(),
      biometricConsentVersion: BIOMETRIC_CONSENT_VERSION,
      faceLastUsedAt: new Date(),
    },
  });

  if (claimed.count === 0) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }

  const updated = await prisma.user.findFirst({ where: { id: userId } });

  await recordAudit({
    actorKind: "USER",
    actorId: userId,
    action: "FACE_ENROLL",
    targetType: "User",
    targetId: userId,
    metadata: { consentVersion: BIOMETRIC_CONSENT_VERSION },
    ip,
  });

  // Return the refreshed safe user (hasFaceScan now true) so the client can
  // update its cached session and stop offering enrollment. The descriptor
  // itself is collapsed to the boolean by toSafeUser and never leaves.
  return { user: toSafeUser(KIND_USER, updated) };
}

/**
 * Step 1 of STEP-BY-STEP enrollment: same fail-fast gate as the batch flow, but
 * issues a step challenge the user proves one action at a time.
 */
export async function prepareEnrollmentStepChallenge(userId) {
  const user = await prisma.user.findFirst({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found.");
  }
  if (hasEnrollment(user)) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }
  return issueStepChallenge({ userId, eventId: null, mode: ENROLL_MODE });
}

/**
 * Verifies ONE action of a step-by-step enrollment. Each step proves its action
 * and, from step 1 on, that it is the SAME person as the step-0 reference; the
 * per-step medoid descriptors accumulate in the (encrypted) challenge state. On
 * the final step the template is derived from that set, checked for
 * cross-account duplication, and stored. A failed step does not advance.
 */
export async function stepEnrollFaceScan(
  userId,
  { frameBuffers, consent, challengeToken, ip } = {}
) {
  const user = await prisma.user.findFirst({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found.");
  }
  if (hasEnrollment(user)) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }

  const { nonce, actions, currentStep, state } = await loadStepChallenge({
    token: challengeToken,
    userId,
    eventId: null,
    mode: ENROLL_MODE,
  });

  // Consent is captured at the first step, before any biometric is derived.
  if (currentStep === 0 && consent !== true) {
    throw new BadRequestError(
      "Biometric consent is required before enrolling your face."
    );
  }

  if (currentStep >= actions.length) {
    throw new ConflictError("This enrollment scan is already complete.");
  }

  const action = actions[currentStep];
  const isLast = currentStep === actions.length - 1;
  const reference = state.descriptors[0] ?? null;

  const verdict = await getEnrollmentVerifier().enrollAction({
    frameBuffers,
    action,
    reference,
    firstTurnSign: state.firstTurnSign,
    userId,
  });

  if (!verdict.passed || !isFaceDescriptor(verdict.descriptor)) {
    // PII-safe diagnostics so a real-world false reject during enrollment can be
    // seen and calibrated (signal aggregates only, never descriptors).
    logger.warn(
      { action, reasons: verdict.reasons, signals: verdict.signals },
      "Enrollment step not satisfied"
    );
    await recordAudit({
      actorKind: "USER",
      actorId: userId,
      action: "FACE_ENROLL_STEP_FAILED",
      targetType: "User",
      targetId: userId,
      metadata: { action, reasons: verdict.reasons, step: true },
      ip,
    }).catch((error) => logger.error(error, "Failed to audit enroll step"));

    throw new BadRequestError(
      "We could not verify a live face for that action. Follow the prompt and try this step again.",
      { code: "STEP_FAILED", context: { action, reasons: verdict.reasons } }
    );
  }

  const newState = {
    descriptors: [...state.descriptors, verdict.descriptor],
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

  // Final step: derive the template from the accumulated step descriptors.
  const derived = finalizeEnrollment(newState.descriptors, ENV.FACE_MATCH_THRESHOLD);
  if (!derived.passed || !isFaceDescriptor(derived.descriptor)) {
    await recordAudit({
      actorKind: "USER",
      actorId: userId,
      action: "FACE_ENROLL_FAILED",
      targetType: "User",
      targetId: userId,
      metadata: { reasons: derived.reasons, stepwise: true },
      ip,
    }).catch((error) => logger.error(error, "Failed to audit enroll finalize"));
    throw new BadRequestError(
      "We could not verify a consistent live face across the scan. Please start again.",
      { context: { reasons: derived.reasons } }
    );
  }

  await assertDescriptorNotEnrolledElsewhere(userId, derived.descriptor, ip);

  const claimed = await prisma.user.updateMany({
    where: { id: userId, faceScanEnc: null },
    data: {
      faceScanEnc: encryptTemplate(derived.descriptor, { userId }),
      biometricConsentAt: new Date(),
      biometricConsentVersion: BIOMETRIC_CONSENT_VERSION,
      faceLastUsedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError(
      "User face scan already exists. Contact an admin to reset your face scan before updating."
    );
  }

  const updated = await prisma.user.findFirst({ where: { id: userId } });

  await recordAudit({
    actorKind: "USER",
    actorId: userId,
    action: "FACE_ENROLL",
    targetType: "User",
    targetId: userId,
    metadata: { consentVersion: BIOMETRIC_CONSENT_VERSION, stepwise: true },
    ip,
  });

  return { done: true, user: toSafeUser(KIND_USER, updated) };
}

/** Owner-or-admin enrollment status; 404 when nothing is enrolled. */
export async function getFaceScanStatus(actor, targetUserId) {
  assertSelfOrAdmin(
    actor,
    targetUserId,
    "Only admins can access other users' face scans."
  );

  const user = await prisma.user.findFirst({ where: { id: targetUserId } });

  if (!user) {
    throw new NotFoundError("User not found.");
  }

  if (!hasEnrollment(user)) {
    throw new NotFoundError("No face scan data found for the user.");
  }

  return { hasFaceScan: true };
}

/** Admin reset: destroys the enrolled template so the user can re-enroll. */
export async function deleteFaceScan(targetUserId, { actor, ip } = {}) {
  const user = await prisma.user.findFirst({ where: { id: targetUserId } });

  if (!user) {
    throw new NotFoundError("User not found.");
  }

  if (!hasEnrollment(user)) {
    throw new NotFoundError(
      `No face scan data found for user with ID ${targetUserId}.`
    );
  }

  await prisma.user.update({
    where: { id: targetUserId },
    data: {
      faceScan: null,
      faceScanEnc: null,
      biometricConsentAt: null,
      biometricConsentVersion: null,
      faceLastUsedAt: null,
    },
  });

  await recordAudit({
    actorKind: actor?.kind ?? "ADMIN",
    actorId: actor ? parseInt(actor.id) : null,
    action: "FACE_RESET",
    targetType: "User",
    targetId: targetUserId,
    ip,
  });
}
