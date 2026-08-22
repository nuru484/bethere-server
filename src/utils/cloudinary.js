// src/utils/cloudinary.js
//
// Shared Cloudinary helpers for every image-bearing domain (profile
// pictures, event covers). Uploads are promised wrappers around
// upload_stream; deletion is best-effort cleanup that never fails the
// request it runs in.
// Importing the setup module is what configures the SDK, so every consumer of
// these helpers is configured no matter which entrypoint loaded it.
import cloudinaryV2 from "../config/cloudinary-setup.js";
import logger from "./logger.js";

/** Delivery-type segment that separates the transformation/id part of a URL. */
const DELIVERY_TYPES = new Set(["upload", "authenticated", "private", "fetch"]);

/**
 * Resolves a Cloudinary delivery URL to the public id `destroy` expects
 * (folder path included, signature and version prefixes and the file
 * extension stripped). A value that is not a URL is assumed to already be a
 * public id.
 */
export function extractPublicIdFromUrl(urlOrPublicId) {
  try {
    // e.g. /<cloud>/image/upload/s--SIG--/v1712345/bethere/abc123.jpg
    const segments = new URL(urlOrPublicId).pathname.split("/").filter(Boolean);
    const typeIndex = segments.findIndex((segment) =>
      DELIVERY_TYPES.has(segment)
    );
    let publicIdSegments =
      typeIndex === -1 ? segments.slice(-1) : segments.slice(typeIndex + 1);
    // A SIGNED delivery URL carries an s--<signature>-- segment ahead of the
    // version. Leaving it in yields a public id no asset matches, so destroy
    // answers "not found" and the asset outlives its retention.
    if (/^s--[\w-]+--$/.test(publicIdSegments[0] ?? "")) {
      publicIdSegments = publicIdSegments.slice(1);
    }
    if (/^v\d+$/.test(publicIdSegments[0] ?? "")) {
      publicIdSegments = publicIdSegments.slice(1);
    }
    return publicIdSegments.join("/").replace(/\.[^/.]+$/, "");
  } catch {
    return urlOrPublicId;
  }
}

/** Uploads an in-memory image buffer and resolves to its secure URL. */
export function uploadImage(buffer, { folder = "bethere" } = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinaryV2.uploader.upload_stream(
      { folder, quality: "auto", fetch_format: "auto" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}

/**
 * Uploads an image as an access-controlled asset (type: "authenticated") and
 * resolves to its PUBLIC ID, not a URL - the asset is not fetchable without a
 * signed delivery URL (see signedImageUrl). Used for biometric evidence
 * frames, which must never sit behind a guessable public URL.
 */
export function uploadAuthenticatedImage(buffer, { folder = "bethere" } = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinaryV2.uploader.upload_stream(
      { folder, type: "authenticated", quality: "auto", fetch_format: "auto" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.public_id);
      }
    );
    uploadStream.end(buffer);
  });
}

/** How long a signed evidence URL stays fetchable once issued. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * Short-lived signed delivery URL for an authenticated asset. Minted at read
 * time from the stored public id, so what sits in the database (and in old
 * API responses, logs, browser history) goes stale instead of granting
 * indefinite access to biometric frames.
 */
export function signedImageUrl(publicId, { expiresInSeconds = SIGNED_URL_TTL_SECONDS } = {}) {
  return cloudinaryV2.url(publicId, {
    type: "authenticated",
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

/**
 * Destroys a Cloudinary asset by URL or public id and REPORTS whether the
 * asset is really gone (true) or not (false). Still non-fatal: nothing is
 * thrown, so the cover-image call sites can keep treating deletion as
 * best-effort cleanup that must never fail the request it runs in. Callers
 * with a retention duty (the evidence purge) act on the return value instead.
 *
 * `type` must match how the asset was uploaded ("authenticated" for evidence
 * frames) - a mismatch makes Cloudinary answer { result: "not found" } with
 * HTTP 200 rather than throwing, which is why the RESULT is inspected and not
 * just the absence of an exception.
 *
 * `invalidate` purges the CDN edge caches as well as the origin asset. It
 * matters for biometric frames stored under public delivery (legacy evidence
 * rows): without it the edges keep serving the face image for the remaining
 * TTL after retention claims to have deleted it.
 */
export async function deleteImage(
  urlOrPublicId,
  { type = "upload", invalidate = false } = {}
) {
  if (!urlOrPublicId) return true;
  try {
    const publicId = extractPublicIdFromUrl(urlOrPublicId);
    const response = await cloudinaryV2.uploader.destroy(publicId, {
      type,
      invalidate,
    });
    if (response?.result !== "ok") {
      logger.warn(
        { publicId, type, result: response?.result },
        "Cloudinary destroy did not report success"
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error(error, `Failed to delete Cloudinary image: ${urlOrPublicId}`);
    return false;
  }
}

/**
 * Wire semantics for image fields on multipart UPDATE endpoints:
 *   field omitted (undefined) -> undefined - leave the column untouched
 *   field ''                  -> null      - remove; the service then deletes
 *                                            the old asset (best-effort)
 *   string                    -> string    - replace (written by the service
 *                                            after a file upload, never
 *                                            client-typed)
 */
export const imageColumnValue = (value) => (value === "" ? null : value);
