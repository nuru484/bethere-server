// test/integration/retention.test.js
//
// The biometric-minimization half of the retention sweep, against the real
// database. The NULL cases matter most: legacy plaintext enrollments predate
// faceLastUsedAt, and `faceLastUsedAt < cutoff` is UNKNOWN for them in SQL, so
// without the updatedAt fallback they survive the purge forever.
import { describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma-client.js";
import { TEMPLATE_DORMANT_DAYS } from "../../src/config/constants.js";
import { runRetention } from "../../src/services/retention.service.js";
import { createAttendant, DESCRIPTOR } from "../helpers.js";

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** updatedAt is managed by Prisma, so backdate the row in SQL. */
async function backdateUpdatedAt(userId, when) {
  await prisma.$executeRaw`UPDATE "User" SET "updatedAt" = ${when} WHERE id = ${userId}`;
}

async function enroll(email, { faceLastUsedAt = null } = {}) {
  const user = await createAttendant({ email });
  return prisma.user.update({
    where: { id: user.id },
    data: {
      faceScan: DESCRIPTOR,
      biometricConsentAt: new Date(),
      biometricConsentVersion: "v1",
      faceLastUsedAt,
    },
  });
}

describe("retention: dormant biometric templates", () => {
  it("purges a legacy enrollment that has never recorded a use", async () => {
    const user = await enroll("legacy@test.local");
    await backdateUpdatedAt(user.id, daysAgo(TEMPLATE_DORMANT_DAYS + 1));

    const counts = await runRetention();
    expect(counts.dormantTemplates).toBe(1);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.faceScan).toBeNull();
    expect(after.faceScanEnc).toBeNull();
    // Consent goes with the template: re-enrolling must re-consent.
    expect(after.biometricConsentAt).toBeNull();
    expect(after.biometricConsentVersion).toBeNull();
  });

  it("keeps a never-used enrollment that is younger than the window", async () => {
    const user = await enroll("fresh@test.local");

    const counts = await runRetention();
    expect(counts.dormantTemplates).toBe(0);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.faceScan).not.toBeNull();
  });

  it("reports a numeric count for EVERY task (a swallowed failure is null)", async () => {
    // runRetention isolates each task and records null on failure, so a task
    // that throws on every sweep (a botched query, a missing column) would go
    // unnoticed if only one key were ever asserted. Every task must have run.
    const counts = await runRetention();
    for (const key of [
      "resetTokens",
      "otpCodes",
      "refreshTokens",
      "challenges",
      "evidence",
      "dormantTemplates",
      "auditLogs",
      "resolvedAnomalies",
    ]) {
      expect(typeof counts[key], `retention task "${key}" returned ${counts[key]}`).toBe("number");
    }
  });

  it("purges a dated template that has gone dormant, keeps an active one", async () => {
    const dormant = await enroll("dormant@test.local", {
      faceLastUsedAt: daysAgo(TEMPLATE_DORMANT_DAYS + 1),
    });
    const active = await enroll("active@test.local", {
      faceLastUsedAt: daysAgo(1),
    });

    const counts = await runRetention();
    expect(counts.dormantTemplates).toBe(1);

    expect(
      (await prisma.user.findUnique({ where: { id: dormant.id } })).faceScan
    ).toBeNull();
    expect(
      (await prisma.user.findUnique({ where: { id: active.id } })).faceScan
    ).not.toBeNull();
  });
});
