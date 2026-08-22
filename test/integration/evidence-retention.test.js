// test/integration/evidence-retention.test.js
//
// The evidence half of the retention sweep. The row is the ONLY record of
// where a frame lives, so deleting it while the remote asset survives orphans
// a biometric image in Cloudinary forever with its public id gone. The purge
// therefore drops only the rows whose assets are confirmed deleted: on a
// worker process with an unconfigured Cloudinary SDK every destroy throws, and
// a swallowed throw would otherwise delete the rows anyway.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/cloudinary.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteImage: vi.fn(async () => true),
}));

const { deleteImage } = await import("../../src/utils/cloudinary.js");
const { prisma } = await import("../../src/config/prisma-client.js");
const { purgeExpiredEvidence } = await import(
  "../../src/services/attendance-evidence.service.js"
);

const expiredEvidence = (frameUrls) =>
  prisma.attendanceEvidence.create({
    data: {
      userId: 1,
      eventId: 1,
      frameUrls,
      expiresAt: new Date(Date.now() - 60_000),
      reason: "LIVENESS_FAILED",
    },
  });

beforeEach(() => {
  deleteImage.mockReset();
  deleteImage.mockResolvedValue(true);
});

describe("purgeExpiredEvidence", () => {
  it("deletes the row once every asset is confirmed gone", async () => {
    const row = await expiredEvidence(["bethere/evidence/a", "bethere/evidence/b"]);

    expect(await purgeExpiredEvidence()).toBe(1);
    expect(
      await prisma.attendanceEvidence.findUnique({ where: { id: row.id } })
    ).toBeNull();

    // Authenticated assets must name their type, or destroy reports "not
    // found"; invalidate drops the CDN copies of the face images too.
    expect(deleteImage).toHaveBeenCalledWith("bethere/evidence/a", {
      type: "authenticated",
      invalidate: true,
    });
  });

  it("keeps the row when an asset delete fails, for the next sweep", async () => {
    const row = await expiredEvidence(["bethere/evidence/keep"]);
    deleteImage.mockResolvedValue(false);

    expect(await purgeExpiredEvidence()).toBe(0);
    expect(
      await prisma.attendanceEvidence.findUnique({ where: { id: row.id } })
    ).not.toBeNull();
  });

  it("purges the healthy rows and keeps only the failing one", async () => {
    const doomed = await expiredEvidence(["ok/one"]);
    const stuck = await expiredEvidence(["broken/two"]);
    deleteImage.mockImplementation(async (value) => !value.startsWith("broken/"));

    expect(await purgeExpiredEvidence()).toBe(1);

    const remaining = await prisma.attendanceEvidence.findMany();
    expect(remaining.map((r) => r.id)).toEqual([stuck.id]);
    expect(remaining.map((r) => r.id)).not.toContain(doomed.id);
  });

  it("passes legacy public URLs through the default upload type", async () => {
    await expiredEvidence([
      "https://res.cloudinary.com/x/image/upload/v1/bethere/evidence/legacy.jpg",
    ]);

    await purgeExpiredEvidence();

    expect(deleteImage).toHaveBeenCalledWith(
      "https://res.cloudinary.com/x/image/upload/v1/bethere/evidence/legacy.jpg",
      { invalidate: true }
    );
  });
});
