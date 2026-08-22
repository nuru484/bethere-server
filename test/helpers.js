// test/helpers.js
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import ENV from "../src/config/env.js";
import { prisma } from "../src/config/prisma-client.js";
import { issueSession } from "../src/services/auth.service.js";
import { COOKIE_NAMES } from "../src/utils/cookie-manager.js";
import { upcomingCodes } from "../src/services/venue-code.service.js";
import { eventCalendarDay } from "../src/utils/time-context.js";

/** The current valid rotating venue code for a known secret (test helper). */
export const venueCodeFor = (venueSecret) => upcomingCodes(venueSecret)[0].code;

/** A stable fake face-api descriptor (128 floats). */
export const DESCRIPTOR = Array.from({ length: 128 }, (_, i) =>
  Number(Math.sin(i).toFixed(6))
);

/** A descriptor far outside the 0.6 match threshold of DESCRIPTOR. */
export const WRONG_DESCRIPTOR = DESCRIPTOR.map((n) => n + 1);

export async function createAttendant({
  email = "user@test.local",
  password = "Password123!",
  faceScan = null,
  phone = null,
  twoFactorEnabled = false,
} = {}) {
  const hashed = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "User",
      email,
      password: hashed,
      faceScan,
      phone,
      twoFactorEnabled,
    },
  });
}

export async function createAdmin({
  email = "admin@test.local",
  password = "Password123!",
  phone = null,
  twoFactorEnabled = false,
} = {}) {
  const hashed = await bcrypt.hash(password, 10);
  return prisma.admin.create({
    data: {
      firstName: "Test",
      lastName: "Admin",
      email,
      password: hashed,
      phone,
      twoFactorEnabled,
    },
  });
}

/** Auth is cookie-only: a Cookie header value for the given principal. */
export function accessCookieFor(kind, principal) {
  const token = jwt.sign(
    { id: principal.id, kind, role: kind, tv: principal.tokenVersion ?? 0 },
    ENV.ACCESS_TOKEN_SECRET,
    { expiresIn: "30m" }
  );
  return `${COOKIE_NAMES.access}=${token}`;
}

export const adminCookie = (admin) => accessCookieFor("ADMIN", admin);
export const attendantCookie = (user) => accessCookieFor("USER", user);

/** A REAL session (registered refresh jti), as login would issue. */
export async function sessionFor(kind, principal) {
  const { accessToken, refreshToken } = await issueSession(kind, principal);
  return {
    accessToken,
    refreshToken,
    cookies: [
      `${COOKIE_NAMES.access}=${accessToken}`,
      `${COOKIE_NAMES.refresh}=${refreshToken}`,
    ],
    refreshCookie: `${COOKIE_NAMES.refresh}=${refreshToken}`,
  };
}

/** Pulls Set-Cookie values from a supertest response into a Cookie header. */
export function cookiesFromResponse(res) {
  const setCookies = res.headers["set-cookie"] ?? [];
  return setCookies.map((c) => c.split(";")[0]);
}

/**
 * Event + location + a session covering today, with an all-day check-in
 * window so time-of-day never flakes a test.
 */
export async function createEventWithActiveSession() {
  const location = await prisma.location.create({
    data: { name: "Test Hall" },
  });

  // Session dates are DATE-ONLY values pinned to the venue's calendar day -
  // exactly what the worker writes and what resolveActiveSession looks up.
  // Building them from the SERVER's local midnight instead would make the
  // suite pass only on a UTC machine.
  const today = eventCalendarDay(new Date());

  const endOfToday = new Date(today);
  endOfToday.setUTCHours(23, 59, 0, 0);

  // venueSecret is set here (the service sets it on real creates); the global
  // omit hides it from query results, so it is returned separately for tests
  // to compute a valid rotating code.
  const venueSecret = crypto.randomBytes(16).toString("hex");

  const event = await prisma.event.create({
    data: {
      title: "Test Event",
      startDate: today,
      isRecurring: false,
      startTime: "00:00",
      endTime: "23:59",
      locationId: location.id,
      type: "MEETING",
      venueSecret,
    },
  });

  const session = await prisma.session.create({
    data: {
      eventId: event.id,
      startDate: today,
      endDate: today,
      startTime: today,
      endTime: endOfToday,
    },
  });

  // The API omits venueSecret from every response; attach it to the returned
  // event for test convenience so a test can compute a valid rotating code.
  event.venueSecret = venueSecret;

  return { location, event, session, venueSecret };
}
