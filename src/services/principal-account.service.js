// src/services/principal-account.service.js
//
// Shared account primitives for the two principal kinds. Admin staff and USER
// attendants live in separate tables with the same account shape, so the
// uniqueness checks, profile edits, picture swaps and password changes are
// written ONCE here and parameterized by kind. The thin user.service.js /
// admin.service.js wrappers keep their existing public names and add only the
// rules that genuinely differ between the kinds (biometric destruction on user
// deletion, passwordless first-password for attendants, the last-admin guard).
import bcrypt from "bcrypt";
import { prisma } from "../config/prisma-client.js";
import { BCRYPT_SALT_ROUNDS } from "../config/constants.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../middleware/error-handler.js";
import { deleteImage, uploadImage } from "../utils/cloudinary.js";
import { tableFor } from "../utils/principal.js";
import { revokeAllSessions, toSafeUser } from "./auth.service.js";

const LABEL = { USER: "User", ADMIN: "Admin" };

/**
 * The public projection per kind. Every field is selected so toSafeUser can
 * derive its booleans (hasPassword, hasFaceScan) consistently; the hash, the
 * descriptor and its ciphertext are all stripped before the DTO leaves. USER
 * carries the biometric + phoneVerified columns; ADMIN does not.
 */
export const PRINCIPAL_SELECT = {
  USER: {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    profilePicture: true,
    phone: true,
    password: true,
    faceScan: true,
    faceScanEnc: true,
    twoFactorEnabled: true,
    phoneVerified: true,
    createdAt: true,
    updatedAt: true,
  },
  ADMIN: {
    id: true,
    password: true,
    firstName: true,
    lastName: true,
    email: true,
    profilePicture: true,
    phone: true,
    twoFactorEnabled: true,
    createdAt: true,
    updatedAt: true,
  },
};

/**
 * Email must be unique across BOTH principal tables: login resolves admins
 * first, so a shared email would shadow the attendant. Uses findUnique ON
 * PURPOSE so it bypasses the soft-delete scope and a removed account still
 * blocks reuse of its email. Excludes the caller's own row when (kind, id) is
 * given (a profile update keeping the same email).
 */
export async function assertEmailAvailable(email, { kind, id } = {}) {
  const [admin, user] = await Promise.all([
    prisma.admin.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { email } }),
  ]);
  const clashes = (row, rowKind) =>
    row && !(rowKind === kind && row.id === id);
  if (clashes(admin, "ADMIN") || clashes(user, "USER")) {
    throw new ConflictError("An account with this email already exists.");
  }
}

/**
 * Phone is unique within the principal's own table (the two tables have
 * separate unique constraints). findUnique bypasses soft-delete so a removed
 * account still blocks reuse.
 */
export async function assertPhoneAvailable(phone, { kind, id } = {}) {
  const existing = await tableFor(kind).findUnique({ where: { phone } });
  if (existing && existing.id !== id) {
    throw new ConflictError(
      `A${kind === "ADMIN" ? "n admin" : " user"} with this phone number already exists.`
    );
  }
}

/** Owner/admin profile update (name/email/phone), shared by both kinds. */
export async function updateProfile({ kind, targetId, details }) {
  // findFirst: a soft-deleted account reads as absent.
  const existing = await tableFor(kind).findFirst({
    where: { id: targetId },
    select: { email: true, phone: true },
  });
  if (!existing) {
    throw new NotFoundError(`${LABEL[kind]} not found.`);
  }

  if (details.email && details.email !== existing.email) {
    await assertEmailAvailable(details.email, { kind, id: targetId });
  }
  if (details.phone && details.phone !== existing.phone) {
    await assertPhoneAvailable(details.phone, { kind, id: targetId });
  }

  const data = {};
  for (const field of ["firstName", "lastName", "email", "phone"]) {
    if (details[field] !== undefined) data[field] = details[field];
  }

  const updated = await tableFor(kind).update({
    where: { id: targetId },
    data,
    select: PRINCIPAL_SELECT[kind],
  });
  return toSafeUser(kind, updated);
}

/**
 * Profile-picture replacement, shared by both kinds: upload the new asset
 * FIRST (a failed upload never leaves the account without a picture), swap the
 * row, then clean up the old asset off the response path (best effort).
 */
export async function updateProfilePicture({ kind, targetId, file }) {
  if (!file) {
    throw new BadRequestError("Profile picture file is required.");
  }

  const row = await tableFor(kind).findFirst({
    where: { id: targetId },
    select: { profilePicture: true },
  });
  if (!row) {
    throw new NotFoundError(`${LABEL[kind]} not found.`);
  }

  const oldPicture = row.profilePicture;
  const secureUrl = await uploadImage(file.buffer);

  const updated = await tableFor(kind).update({
    where: { id: targetId },
    data: { profilePicture: secureUrl },
    select: PRINCIPAL_SELECT[kind],
  });

  if (oldPicture) void deleteImage(oldPicture);
  return toSafeUser(kind, updated);
}

/**
 * Sets or changes a password, then revokes every session (a changed password
 * must kill an attacker's tokens too).
 * - `allowPasswordless` (attendants): an account with no password yet SETS its
 *   first one with no current-password check.
 * - Accounts that already have a password ALWAYS supply the correct current
 *   one, enforced here regardless of what the client sent.
 */
export async function changePassword({
  kind,
  id,
  currentPassword,
  newPassword,
  allowPasswordless = false,
}) {
  const row = await tableFor(kind).findFirst({
    where: { id },
    select: { password: true },
  });
  if (!row) {
    throw new NotFoundError(`${LABEL[kind]} not found.`);
  }

  if (row.password) {
    if (!currentPassword) {
      throw new BadRequestError("Your current password is required.");
    }
    if (currentPassword === newPassword) {
      throw new BadRequestError(
        "New password cannot be the same as current password."
      );
    }
    if (!(await bcrypt.compare(currentPassword, row.password))) {
      throw new BadRequestError("Current password is incorrect.");
    }
  } else if (!allowPasswordless) {
    // A kind expected to always have a password but somehow has none: refuse
    // rather than silently setting one without proving the current identity.
    throw new BadRequestError("Your current password is required.");
  }
  // Passwordless attendant: fall through and set the first password.

  const hashed = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
  await tableFor(kind).update({ where: { id }, data: { password: hashed } });

  await revokeAllSessions(kind, id);
}
