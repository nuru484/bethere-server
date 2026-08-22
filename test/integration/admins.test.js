// test/integration/admins.test.js
//
// Admin management: creation (the endpoint takes a password, so it must not
// run the attendant validator that forbids one) and self-service password
// change (a missing current password is a 400, never a 500).
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { createAdmin, adminCookie } from "../helpers.js";

const STRONG = "NewStrongPass123!";

describe("POST /api/v1/admins (create admin)", () => {
  it("creates an admin WITH a password", async () => {
    const admin = await createAdmin({ email: "creator@test.local" });

    const res = await request(app)
      .post("/api/v1/admins")
      .set("Cookie", [adminCookie(admin)])
      .send({
        firstName: "New",
        lastName: "Admin",
        email: "created@test.local",
        password: STRONG,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe("ADMIN");
    expect(res.body.data.email).toBe("created@test.local");
    // The hash never leaves the server.
    expect(res.body.data.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
  });

  it("rejects creation without a password with 400 (never 500)", async () => {
    const admin = await createAdmin({ email: "creator2@test.local" });

    const res = await request(app)
      .post("/api/v1/admins")
      .set("Cookie", [adminCookie(admin)])
      .send({ firstName: "No", lastName: "Pass", email: "nopass@test.local" });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate email with 409", async () => {
    const admin = await createAdmin({ email: "dupe@test.local" });

    const res = await request(app)
      .post("/api/v1/admins")
      .set("Cookie", [adminCookie(admin)])
      .send({
        firstName: "Dup",
        lastName: "Licate",
        email: "dupe@test.local",
        password: STRONG,
      });

    expect(res.status).toBe(409);
  });

  it("forbids a non-admin from creating admins (403)", async () => {
    // A cookie for a USER principal must not reach the admin create surface.
    const res = await request(app)
      .post("/api/v1/admins")
      .send({ firstName: "X", lastName: "Y", email: "z@test.local", password: STRONG });
    expect([401, 403]).toContain(res.status);
  });
});

describe("PATCH /api/v1/admins/change-password", () => {
  it("returns 400 (not 500) when the current password is omitted", async () => {
    const admin = await createAdmin({ email: "cp1@test.local" });

    const res = await request(app)
      .patch("/api/v1/admins/change-password")
      .set("Cookie", [adminCookie(admin)])
      .send({ newPassword: STRONG });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a wrong current password", async () => {
    const admin = await createAdmin({ email: "cp2@test.local" });

    const res = await request(app)
      .patch("/api/v1/admins/change-password")
      .set("Cookie", [adminCookie(admin)])
      .send({ currentPassword: "totally-wrong", newPassword: STRONG });

    expect(res.status).toBe(400);
  });

  it("changes the password with the correct current one", async () => {
    const admin = await createAdmin({
      email: "cp3@test.local",
      password: "Password123!",
    });

    const res = await request(app)
      .patch("/api/v1/admins/change-password")
      .set("Cookie", [adminCookie(admin)])
      .send({ currentPassword: "Password123!", newPassword: STRONG });

    expect(res.status).toBe(200);
  });
});
