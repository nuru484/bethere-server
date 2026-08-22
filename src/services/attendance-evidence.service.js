// src/services/attendance-evidence.service.js
//
// Retains captured frames ONLY for flagged/anomalous attempts (data
// minimization - a normal check-in stores no images). Frames go to Cloudinary
// under a dedicated folder; expiresAt drives the retention purge that deletes
// both the DB row and the remote assets.
import { prisma } from "../config/prisma-client.js";
import {
  deleteImage,
  signedImageUrl,
  uploadAuthenticatedImage,
} from "../utils/cloudinary.js";
import logger from "../utils/logger.js";
import {
  EVIDENCE_PURGE_BATCH,
  EVIDENCE_PURGE_MAX_PER_RUN,
  EVIDENCE_RETENTION_DAYS,
} from "../config/constants.js";

const EVIDENCE_FOLDER = "bethere/evidence";

/**
 * Legacy rows store the public delivery URL itself; rows written since
 * evidence became authenticated-delivery store the Cloudinary public id. The
 * scheme prefix is the discriminator - a public id never starts with one.
 */
export const isLegacyFrameValue = (value) => /^https?:\/\//i.test(value ?? "");

/**
 * Resolves a stored frame value to the URL a client may see. Legacy URL
 * values pass through unchanged so old evidence keeps rendering; public ids
 * are signed into short-lived URLs at read time, so nothing durable in the
 * database or an API response grants standing access to biometric frames.
 */
export function toClientFrameUrl(value) {
  return isLegacyFrameValue(value) ? value : signedImageUrl(value);
}

/**
 * Stores up to a few evidence frames for a flagged attempt and returns the
 * evidence row. Best-effort per frame; a failed upload is skipped, not fatal.
 */
export async function storeEvidence({
  userId,
  eventId,
  attendanceId = null,
  frameBuffers,
  livenessScore = null,
  matchDistance = null,
  reason = null,
}) {
  // Cap the retained frames: a couple of key frames are enough to review.
  const buffers = frameBuffers.slice(0, 3);
  // Access-controlled uploads: the column keeps its name but new values are
  // public ids, signed into expiring URLs only when an admin reviews them.
  const frameUrls = [];
  for (const buffer of buffers) {
    try {
      frameUrls.push(
        await uploadAuthenticatedImage(buffer, { folder: EVIDENCE_FOLDER })
      );
    } catch (error) {
      logger.error(error, "Failed to upload evidence frame");
    }
  }

  const expiresAt = new Date(
    Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  return prisma.attendanceEvidence.create({
    data: {
      userId,
      eventId,
      attendanceId,
      frameUrls,
      livenessScore,
      matchDistance,
      reason,
      expiresAt,
    },
  });
}

/**
 * Retention: deletes evidence past its expiry, destroying the Cloudinary
 * assets FIRST and dropping only the rows whose assets are confirmed gone.
 *
 * The row is the only record of where the frames live: deleting it while the
 * remote assets survive orphans biometric images in Cloudinary forever with
 * their public ids lost. A row whose assets failed to delete is therefore
 * kept for the next sweep and reported in the logs.
 */
export async function purgeExpiredEvidence() {
  let purgedTotal = 0;
  const retainedIds = [];

  // Batched: each row costs Cloudinary round-trips, so a backlog (job broken
  // for a while) drains in bounded slices per sweep instead of one unbounded
  // run. Rows whose assets could not be deleted are skipped by id so a batch
  // of stuck rows cannot loop forever.
  while (purgedTotal < EVIDENCE_PURGE_MAX_PER_RUN) {
    const expired = await prisma.attendanceEvidence.findMany({
      where: {
        expiresAt: { lt: new Date() },
        ...(retainedIds.length ? { id: { notIn: retainedIds } } : {}),
      },
      select: { id: true, frameUrls: true },
      take: EVIDENCE_PURGE_BATCH,
      orderBy: { id: "asc" },
    });
    if (expired.length === 0) break;

    const purgeableIds = [];

    for (const row of expired) {
      const frames = Array.isArray(row.frameUrls) ? row.frameUrls : [];
      // Legacy rows hold public-delivery URLs (default "upload" type); new
      // rows hold public ids of authenticated assets - destroy must name the
      // right type or Cloudinary reports "not found" and the frames outlive
      // retention. invalidate: these are face images, so the CDN edges must
      // drop them too.
      const results = await Promise.all(
        frames.map((frame) =>
          isLegacyFrameValue(frame)
            ? deleteImage(frame, { invalidate: true })
            : deleteImage(frame, { type: "authenticated", invalidate: true })
        )
      );

      if (results.every(Boolean)) purgeableIds.push(row.id);
      else retainedIds.push(row.id);
    }

    if (purgeableIds.length > 0) {
      const { count } = await prisma.attendanceEvidence.deleteMany({
        where: { id: { in: purgeableIds } },
      });
      purgedTotal += count;
    }

    // Nothing in this batch could be purged: no progress is possible now.
    if (purgeableIds.length === 0) break;
    if (expired.length < EVIDENCE_PURGE_BATCH) break;
  }

  if (retainedIds.length > 0) {
    logger.warn(
      { retained: retainedIds.length, purged: purgedTotal, retainedIds },
      "Evidence rows kept: their Cloudinary assets could not be deleted"
    );
  }

  return purgedTotal;
}
