// prisma/bootstrap.js
//
// Production bootstrap: the smallest amount of data a real deployment needs
// before anyone can sign in. Deliberately NOT prisma/seed.js, which exists to
// make a development database look alive and creates demo accounts, sample
// attendants, events and fabricated attendance.
//
// What this creates:
//   - one Admin from ADMIN_EMAIL / ADMIN_FIRSTNAME / ADMIN_LASTNAME /
//     ADMIN_PHONE, with a GENERATED temporary password printed once
//
// The password is never read from the environment. A long-lived shared
// credential sitting in a deployment's env is worth less than a value printed
// to the release log and changed at first sign-in, and it means production
// carries no ADMIN_PASSWORD at all.
//
// Idempotent: safe to run on every deploy. An existing admin - resolved by
// email OR phone, both of which are login identifiers - is left completely
// untouched: no password reset, no contact change.
import bcrypt from "bcrypt";
import crypto from "crypto";
import { prisma } from "../src/config/prisma-client.js";
import ENV from "../src/config/env.js";
import logger from "../src/utils/logger.js";

/** Matches the cost the auth service hashes with. */
const SALT_ROUNDS = 10;

/**
 * A temporary password that clears the registration rules with room to spare
 * and is unguessable. Printed once, stored in plain text nowhere.
 */
const generateTempPassword = () => crypto.randomBytes(12).toString("base64url");

/**
 * Returns null rather than throwing when the admin identity is absent: this
 * runs as part of the release command, and a deployment that never intends to
 * bootstrap an admin should not have its build fail over it. The log names
 * exactly what is missing, so a bootstrap that was meant to happen is not
 * silently skipped either.
 */
const readAdminEnv = () => {
  const missing = ["ADMIN_EMAIL", "ADMIN_FIRSTNAME", "ADMIN_LASTNAME"].filter(
    (name) => !ENV[name]
  );
  if (missing.length > 0) {
    logger.info(
      `Bootstrap skipped: ${missing.join(", ")} not set. Set them and re-run to create the first admin.`
    );
    return null;
  }
  return {
    email: ENV.ADMIN_EMAIL.toLowerCase().trim(),
    firstName: ENV.ADMIN_FIRSTNAME,
    lastName: ENV.ADMIN_LASTNAME,
    phone: ENV.ADMIN_PHONE ?? null,
  };
};

async function main() {
  // Explicit opt-in, the same shape the seed uses. Without it the step is a
  // no-op, so the admin identity can sit in the deploy's secrets permanently
  // while the account is created on exactly one run.
  if (!ENV.ADMIN_BOOTSTRAP_ENABLED) {
    logger.info("Bootstrap skipped (ADMIN_BOOTSTRAP_ENABLED is not true).");
    return;
  }

  const adminEnv = readAdminEnv();
  if (!adminEnv) return;
  const { email, firstName, lastName, phone } = adminEnv;

  // findUnique is unscoped, so a soft-deleted admin still counts as holding
  // its contacts - which is what the unique constraints care about.
  const [byEmail, byPhone] = await Promise.all([
    prisma.admin.findUnique({ where: { email } }),
    phone ? prisma.admin.findUnique({ where: { phone } }) : Promise.resolve(null),
  ]);
  const existing = byEmail ?? byPhone;
  if (existing) {
    logger.info(
      { admin: { id: existing.id, email: existing.email } },
      "Bootstrap: an admin already holds those contacts; nothing changed"
    );
    return;
  }

  const temporaryPassword = generateTempPassword();
  const admin = await prisma.admin.create({
    data: {
      email,
      firstName,
      lastName,
      password: await bcrypt.hash(temporaryPassword, SALT_ROUNDS),
      phone,
    },
  });

  logger.info(
    { admin: { id: admin.id, email: admin.email } },
    "Bootstrap: admin created"
  );
  // The one place this value ever appears. Change it at first sign-in.
  logger.info(
    `Temporary password (change it at first sign-in): ${temporaryPassword}`
  );
}

main()
  .catch((error) => {
    logger.error(error, "Bootstrap failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
