// src/services/password-reset.service.js
//
// Domain logic for the password reset flow, for BOTH principals (admins and
// attendants). Controllers stay thin. Everything security-sensitive (token
// hashing, expiry, single-use, enumeration safety) lives here so it is
// defined once. Reset rows carry (kind, principalId) because the two
// principal tables have overlapping ids.
import crypto from "crypto";
import bcrypt from "bcrypt";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../config/prisma-client.js";
import { BCRYPT_SALT_ROUNDS } from "../config/constants.js";
import {
  ValidationError,
  BadRequestError,
} from "../middleware/error-handler.js";
import sendPasswordResetEmail from "../utils/send-mail.js";
import {
  findPrincipal,
  findPrincipalByEmail,
  revokeAllSessions,
} from "./auth.service.js";
import ENV from "../config/env.js";
import { dispatchAsync } from "../utils/dispatch-async.js";
import logger from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Reset links are valid for 15 minutes. */
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Hashes a raw reset token the same way for storage and lookup. */
const hashResetToken = (rawToken) =>
  crypto.createHash("sha256").update(rawToken).digest("hex");

/**
 * Loads a reset request by raw token, asserts it is usable, and resolves
 * its principal. Throws a deliberately generic BadRequestError when the
 * token is unknown, used, expired, or its account is gone - never revealing
 * which.
 */
const getUsableResetRequest = async (rawToken) => {
  const tokenHash = hashResetToken(rawToken);

  const resetRequest = await prisma.passwordReset.findUnique({
    where: { tokenHash },
  });

  const invalid = () => {
    throw new BadRequestError(
      "Invalid or expired password reset link. Please request a new one."
    );
  };

  if (!resetRequest || resetRequest.usedAt || new Date() > resetRequest.expiresAt) {
    invalid();
  }

  const principal = await findPrincipal(
    resetRequest.kind,
    resetRequest.principalId
  );
  if (!principal) invalid();

  return { resetRequest, principal };
};

/** Sends the reset email; failures are logged but never surfaced. */
const sendResetEmail = async (principal, rawToken) => {
  const resetLink = `${ENV.FRONTEND_URL}/reset-password?token=${rawToken}`;

  try {
    await sendPasswordResetEmail({
      email: principal.email,
      subject: "Password Reset - BeThere",
      template: "reset-password.ejs",
      data: {
        userFirstName: principal.firstName,
        userLastName: principal.lastName,
        resetLink,
      },
      attachments: [
        {
          filename: "logo.png",
          path: path.join(__dirname, "../../public/assets/logo.png"),
          cid: "logo", // matches cid:logo in the email template
        },
      ],
    });
  } catch (emailError) {
    logger.error(emailError, "Failed to send password reset email");
  }
};

/**
 * Starts a password reset for whichever principal owns the email (admins
 * first). Never throws on a missing account - the caller always responds
 * with the same generic message to avoid enumeration.
 */
export const requestPasswordReset = async (email) => {
  const resolved = await findPrincipalByEmail(email.toLowerCase());
  if (!resolved) return;

  const { kind, principal } = resolved;

  // Invalidate any still-active tokens before issuing a new one.
  await prisma.passwordReset.updateMany({
    where: {
      kind,
      principalId: principal.id,
      usedAt: null,
      expiresAt: { gte: new Date() },
    },
    data: { usedAt: new Date() },
  });

  const rawToken = crypto.randomBytes(32).toString("hex");

  await prisma.passwordReset.create({
    data: {
      kind,
      principalId: principal.id,
      tokenHash: hashResetToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  // Fire-and-forget: awaiting SMTP here makes a known email measurably slower
  // than an unknown one (which returns above), re-opening enumeration by
  // timing. The DB writes are done; only the send is deferred.
  dispatchAsync(() => sendResetEmail(principal, rawToken), "password reset email");
};

/**
 * Verifies a reset token without consuming it (for the "enter new password"
 * screen). Throws BadRequestError when the token is not usable.
 */
export const verifyResetToken = async (rawToken) => {
  const { principal } = await getUsableResetRequest(rawToken);
  return {
    email: principal.email,
    firstName: principal.firstName,
  };
};

/**
 * Completes a password reset: validates the confirmation, rejects reusing
 * the current password, atomically sets the new password and consumes the
 * token, then revokes every outstanding session for the account.
 */
export const resetPassword = async ({ token, newPassword, confirmPassword }) => {
  if (newPassword !== confirmPassword) {
    throw new ValidationError("Passwords do not match.");
  }

  const { resetRequest, principal } = await getUsableResetRequest(token);

  // Passwordless accounts (admin-created attendants) are SETTING their
  // first password here, so there is nothing to compare against.
  if (principal.password) {
    const isSamePassword = await bcrypt.compare(
      newPassword,
      principal.password
    );
    if (isSamePassword) {
      throw new BadRequestError(
        "New password must be different from your current password."
      );
    }
  }

  const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
  const table = resetRequest.kind === "ADMIN" ? prisma.admin : prisma.user;

  await prisma.$transaction([
    table.update({
      where: { id: resetRequest.principalId },
      data: { password: hashedPassword },
    }),
    prisma.passwordReset.update({
      where: { id: resetRequest.id },
      data: { usedAt: new Date() },
    }),
    prisma.passwordReset.updateMany({
      where: {
        kind: resetRequest.kind,
        principalId: resetRequest.principalId,
        id: { not: resetRequest.id },
        usedAt: null,
      },
      data: { usedAt: new Date() },
    }),
  ]);

  // A reset usually means the old credential is suspect - kill every
  // outstanding session along with it.
  await revokeAllSessions(resetRequest.kind, resetRequest.principalId);
};

/**
 * Removes expired reset tokens. Invoked by a scheduled background job.
 * Returns the number of rows deleted.
 */
export const cleanupExpiredResetTokens = async () => {
  const { count } = await prisma.passwordReset.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
};
