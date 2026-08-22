// test/integration/security-regressions.test.js
//
// Locks two invariants: a soft-deleted admin must not be able to log back
// in, and the change-password endpoint must let passwordless accounts set a
// first password while still requiring the current one when a password exists.
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";
import { createAdmin, createAttendant, attendantCookie } from "../helpers.js";

describe("soft-deleted admin login", () => {
  it("refuses login for a soft-deleted admin", async () => {
    const admin = await createAdmin({ email: "gone@test.local" });
    // Single-row update is not soft-delete-scoped, so this actually deletes.
    await prisma.admin.update({
      where: { id: admin.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "gone@test.local", password: "Password123!" });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
  });
});

describe("PATCH change-password: set vs change", () => {
  it("lets a passwordless account set a first password with no current one", async () => {
    const user = await prisma.user.create({
      data: { firstName: "No", lastName: "Pass", email: "np@test.local" },
    });

    const res = await request(app)
      .patch("/api/v1/users/change-password")
      .set("Cookie", [attendantCookie(user)])
      .send({ newPassword: "BrandNewPass123!" });

    expect(res.status).toBe(200);
  });

  it("still requires the current password when the account has one", async () => {
    const user = await createAttendant({ email: "hp@test.local" });

    const res = await request(app)
      .patch("/api/v1/users/change-password")
      .set("Cookie", [attendantCookie(user)])
      .send({ newPassword: "BrandNewPass123!" }); // no currentPassword

    expect(res.status).toBe(400);
  });
});
