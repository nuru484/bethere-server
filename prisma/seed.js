// prisma/seed.js
//
// Seeds the operator admin, the one-click demo-login accounts, AND a rich,
// idempotent, time-anchored demo dataset - all under the single
// ADMIN_SEED_ENABLED opt-in, so `npm run seed` populates a database a visitor
// can actually explore (every dashboard, report, filter and live view).
//
// The demo dataset is SAFE TO RE-RUN at any time: it owns a fixed set of demo
// people/events (matched by email/title), clears only its own transactional
// data (sessions cascade to attendance; anomalies/evidence by demo event id),
// and regenerates everything relative to TODAY. Run it again next month and the
// whole window slides forward, so the site always shows current, active data.
// Non-demo records are never touched.
import crypto from "node:crypto";
import * as bcrypt from "bcrypt";
import { prisma } from "../src/config/prisma-client.js";
import logger from "../src/utils/logger.js";
import ENV from "../src/config/env.js";
import {
  addUtcDays,
  currentTimeStringInEventTz,
  eventCalendarDay,
  eventTimeOnDay,
} from "../src/utils/time-context.js";

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
const chance = (p) => Math.random() < p;

async function main() {
  // Explicit opt-in: without ADMIN_SEED_ENABLED=true the seed is a no-op, so a
  // deploy pipeline can never silently plant demo data in production.
  if (!ENV.ADMIN_SEED_ENABLED) {
    logger.info("Seed skipped (ADMIN_SEED_ENABLED is not true).");
    return;
  }

  // The admin credentials are optional in the environment - nothing but this
  // script reads them - so the assertion lives here, where a missing value is
  // a seed that cannot do its job rather than an API that will not boot.
  const missing = [
    "ADMIN_EMAIL",
    "ADMIN_FIRSTNAME",
    "ADMIN_LASTNAME",
    "ADMIN_PASSWORD",
  ].filter((name) => !ENV[name]);
  if (missing.length > 0) {
    throw new Error(
      `Seeding needs these environment variables: ${missing.join(", ")}`
    );
  }

  logger.info("Starting database seeding...");

  // Dedicated demo principals for the one-click demo login (never the real
  // admin). The demo admin gets a RANDOM password rotated every run, so it is
  // never a known credential - demo-login resolves it by email and mints a
  // session with no password check, so the demo still works while the normal
  // /auth/login path cannot reach it.
  if (ENV.DEMO_LOGIN_ENABLED) {
    const demoPassword = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
    await prisma.admin.upsert({
      where: { email: ENV.DEMO_ADMIN_EMAIL },
      update: { password: demoPassword },
      create: { email: ENV.DEMO_ADMIN_EMAIL, firstName: "Demo", lastName: "Admin", password: demoPassword },
    });
    await prisma.user.upsert({
      where: { email: ENV.DEMO_ATTENDANT_EMAIL },
      update: {},
      create: { email: ENV.DEMO_ATTENDANT_EMAIL, firstName: "Demo", lastName: "Attendant" },
    });
    logger.info("Demo admin + attendant ensured for one-click demo login");
  }

  // ============ OPERATOR ADMIN (create-only) ============
  // Resolve by email OR phone (both unique login identifiers) so an existing
  // admin - however it was created - is reused rather than colliding on a
  // unique constraint on re-run. findUnique is unscoped, so a soft-deleted
  // admin still counts as holding its contacts.
  const [adminByEmail, adminByPhone] = await Promise.all([
    prisma.admin.findUnique({ where: { email: ENV.ADMIN_EMAIL } }),
    ENV.ADMIN_PHONE
      ? prisma.admin.findUnique({ where: { phone: ENV.ADMIN_PHONE } })
      : Promise.resolve(null),
  ]);
  const existingAdmin = adminByEmail ?? adminByPhone;
  if (existingAdmin) {
    logger.info({ message: "Operator admin already exists", admin: { id: existingAdmin.id, email: existingAdmin.email } });
  } else {
    const admin = await prisma.admin.create({
      data: {
        email: ENV.ADMIN_EMAIL,
        firstName: ENV.ADMIN_FIRSTNAME,
        lastName: ENV.ADMIN_LASTNAME,
        password: await bcrypt.hash(ENV.ADMIN_PASSWORD, 10),
        phone: ENV.ADMIN_PHONE,
      },
    });
    logger.info({ message: "Operator admin created", admin: { id: admin.id, email: admin.email } });
  }

  // ============ RICH DEMO DATA (idempotent, time-anchored) ============
  await seedDemoData();

  logger.info("Database seeding completed successfully!");
}

/**
 * Populates (and on re-run refreshes) the demo attendance dataset. Sample
 * attendants get random passwords - they are inspected via the dashboards or
 * signed into via OTP/reset, never a published credential. Visitors explore the
 * site through the one-click demo login above.
 */
async function seedDemoData() {
  const now = new Date();
  const today = eventCalendarDay(now);
  const ATTENDANT_COUNT = 25;
  const FIRST_NAMES = ["Ama", "Kofi", "Yaa", "Kwame", "Abena", "Kojo", "Esi", "Yaw", "Adwoa", "Fiifi", "Akosua", "Kwesi", "Efua", "Nana", "Maya", "Zara", "Ibrahim", "Fatima", "Musa", "Aisha", "Sena", "Elorm", "Dela", "Selorm", "Mawuli"];
  const samplePassword = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);

  // Free stock imagery (Unsplash CDN) for event covers, and pravatar avatars
  // for attendants, so the UI looks real.
  const EVENT_PHOTO = {
    MEETING: "https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=800&q=80",
    CLASS: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=800&q=80",
    TRAINING: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=800&q=80",
    EVENT: "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=800&q=80",
  };
  const avatar = (i) => `https://i.pravatar.cc/150?img=${(i % 70) + 1}`;

  // The demo-login attendant, enriched so its personal dashboard is rich too.
  const demoAttendant = await prisma.user.upsert({
    where: { email: ENV.DEMO_ATTENDANT_EMAIL },
    update: { faceScanEnc: "demo-encrypted-template", faceLastUsedAt: addUtcDays(today, -1), profilePicture: avatar(0) },
    create: {
      email: ENV.DEMO_ATTENDANT_EMAIL,
      firstName: "Demo",
      lastName: "Attendant",
      faceScanEnc: "demo-encrypted-template",
      biometricConsentAt: addUtcDays(today, -60),
      biometricConsentVersion: "2026-07-v1",
      phoneVerified: true,
      profilePicture: avatar(0),
    },
  });

  // Sample attendants (deterministic identities so re-runs update, not pile up;
  // ~80% enrolled to give enrollment coverage something to show).
  const users = [];
  for (let i = 0; i < ATTENDANT_COUNT; i += 1) {
    const enrolled = i % 5 !== 0;
    users.push(
      await prisma.user.upsert({
        where: { email: `attendant${i}@demo.local` },
        update: {
          faceScanEnc: enrolled ? "demo-encrypted-template" : null,
          faceLastUsedAt: enrolled ? addUtcDays(today, -(i % 10)) : null,
          profilePicture: avatar(i + 1),
        },
        create: {
          firstName: FIRST_NAMES[i],
          lastName: `A${i}`,
          email: `attendant${i}@demo.local`,
          password: samplePassword,
          faceScanEnc: enrolled ? "demo-encrypted-template" : null,
          biometricConsentAt: enrolled ? addUtcDays(today, -(30 + i)) : null,
          biometricConsentVersion: enrolled ? "2026-07-v1" : null,
          faceLastUsedAt: enrolled ? addUtcDays(today, -(i % 10)) : null,
          phoneVerified: i % 3 !== 0,
          profilePicture: avatar(i + 1),
        },
      })
    );
  }
  users.push(demoAttendant);

  // Locations (varied cities/countries so location filters have range).
  const locations = [];
  for (const data of [
    { name: "Main Auditorium", city: "Accra", country: "Ghana" },
    { name: "Innovation Lab", city: "Accra", country: "Ghana" },
    { name: "Training Room B", city: "Kumasi", country: "Ghana" },
    { name: "Riverside Hall", city: "Takoradi", country: "Ghana" },
  ]) {
    const existing = await prisma.location.findFirst({ where: { name: data.name } });
    locations.push(existing ?? (await prisma.location.create({ data })));
  }

  // A window around "now" for the live event, so one session is always open at
  // run time (drives the live strip and the attendant check-in CTA).
  let liveStart = currentTimeStringInEventTz(new Date(now.getTime() - 40 * 60_000));
  let liveEnd = currentTimeStringInEventTz(new Date(now.getTime() + 160 * 60_000));
  if (liveStart >= liveEnd) {
    liveStart = "00:00";
    liveEnd = "23:59";
  }

  // Events: recurring + one-off + a live-now + an upcoming. offsets are DAYS
  // FROM TODAY (negative = past, 0 = today, positive = future).
  const eventConfigs = [
    { title: "Morning Standup", isRecurring: true, startTime: "09:00", endTime: "11:00", type: "MEETING", loc: 1, cadence: 1, span: 45, future: 10 },
    { title: "Weekly Sync", isRecurring: true, startTime: "14:00", endTime: "16:00", type: "MEETING", loc: 0, cadence: 7, span: 340, future: 14 },
    { title: "Evening Class", isRecurring: true, startTime: "18:00", endTime: "20:00", type: "CLASS", loc: 2, cadence: 2, span: 40, future: 10 },
    { title: "Security Training", isRecurring: false, startTime: "10:00", endTime: "12:00", type: "TRAINING", loc: 2, offset: -12 },
    { title: "Community Meetup", isRecurring: false, startTime: "15:00", endTime: "17:00", type: "EVENT", loc: 3, offset: -3 },
    { title: "Team Huddle", isRecurring: false, startTime: liveStart, endTime: liveEnd, type: "MEETING", loc: 1, offset: 0, live: true },
    { title: "Annual Gala", isRecurring: false, startTime: "18:00", endTime: "22:00", type: "EVENT", loc: 0, offset: 5 },
  ];

  const eventByTitle = new Map();
  const events = [];
  for (const cfg of eventConfigs) {
    const location = locations[cfg.loc];
    const firstOff = cfg.isRecurring ? -cfg.span : cfg.offset;
    const lastOff = cfg.isRecurring ? cfg.future : cfg.offset;
    const data = {
      title: cfg.title,
      description: `${cfg.title} at ${location.name}`,
      startDate: addUtcDays(today, firstOff),
      endDate: addUtcDays(today, lastOff),
      isRecurring: cfg.isRecurring,
      recurrenceInterval: cfg.cadence ?? 1,
      durationDays: 1,
      startTime: cfg.startTime,
      endTime: cfg.endTime,
      locationId: location.id,
      type: cfg.type,
      coverImage: EVENT_PHOTO[cfg.type] ?? EVENT_PHOTO.EVENT,
    };
    const existing = await prisma.event.findFirst({ where: { title: cfg.title } });
    const event = existing
      ? await prisma.event.update({ where: { id: existing.id }, data })
      : await prisma.event.create({ data });
    events.push(event);
    eventByTitle.set(cfg.title, { event, cfg });
  }

  // Retire demo events this seed no longer manages, so a re-run never
  // leaves stale data behind.
  const retired = await prisma.event.findMany({
    where: { title: { in: ["All-Day Conference"] } },
    select: { id: true },
  });
  if (retired.length) {
    const retiredIds = retired.map((event) => event.id);
    await prisma.anomalyFlag.deleteMany({ where: { eventId: { in: retiredIds } } });
    await prisma.attendanceEvidence.deleteMany({ where: { eventId: { in: retiredIds } } });
    await prisma.session.deleteMany({ where: { eventId: { in: retiredIds } } });
    await prisma.event.deleteMany({ where: { id: { in: retiredIds } } });
  }

  // Clear this seed's OWN transactional data (scoped to the demo events),
  // then regenerate fresh. Deleting sessions cascades to attendance.
  const demoEventIds = events.map((event) => event.id);
  await prisma.anomalyFlag.deleteMany({ where: { eventId: { in: demoEventIds } } });
  await prisma.attendanceEvidence.deleteMany({ where: { eventId: { in: demoEventIds } } });
  await prisma.session.deleteMany({ where: { eventId: { in: demoEventIds } } });

  // Sessions (past + today + future).
  const sessions = [];
  for (const { event, cfg } of eventByTitle.values()) {
    const offsets = [];
    if (cfg.isRecurring) {
      for (let off = -cfg.span; off <= cfg.future; off += cfg.cadence) offsets.push(off);
    } else {
      offsets.push(cfg.offset);
    }
    for (const off of offsets) {
      const day = addUtcDays(today, off);
      const startInstant = eventTimeOnDay(day, cfg.startTime);
      const session = await prisma.session.create({
        data: {
          eventId: event.id,
          startDate: day,
          endDate: day,
          startTime: startInstant,
          endTime: eventTimeOnDay(day, cfg.endTime),
          finalizedAt: off < 0 ? addUtcDays(day, 1) : null,
        },
      });
      sessions.push({
        id: session.id,
        startInstant,
        isToday: off === 0,
        isFuture: off > 0,
        isLive: Boolean(cfg.live) && off === 0,
      });
    }
  }

  // Attendance.
  const rows = [];
  for (const session of sessions) {
    if (session.isFuture) continue;

    if (session.isLive) {
      // People currently on the floor. The demo attendant is left out so their
      // personal dashboard shows the "check in" CTA.
      for (const user of users) {
        if (user.id === demoAttendant.id) continue;
        if (!chance(0.55)) continue;
        const checkIn = new Date(now.getTime() - rand(2, 38) * 60_000);
        const lateMin = (checkIn.getTime() - session.startInstant.getTime()) / 60_000;
        const stillIn = chance(0.5);
        rows.push({
          userId: user.id,
          sessionId: session.id,
          status: lateMin <= 60 ? "PRESENT" : "LATE",
          checkInTime: checkIn,
          checkOutTime: stillIn ? null : new Date(Math.min(now.getTime(), checkIn.getTime() + rand(15, 55) * 60_000)),
          autoCheckedOut: false,
          createdAt: checkIn,
        });
      }
      continue;
    }

    const turnout = rand(0.55, 0.9);
    for (const user of users) {
      if (!chance(turnout)) {
        if (!session.isToday && chance(0.5)) {
          rows.push({
            userId: user.id,
            sessionId: session.id,
            status: "ABSENT",
            checkInTime: null,
            createdAt: addUtcDays(new Date(session.startInstant), 1),
          });
        }
        continue;
      }
      const lateMinutes = chance(0.72) ? rand(0, 45) : rand(46, 150);
      const checkIn = new Date(session.startInstant.getTime() + lateMinutes * 60_000);
      rows.push({
        userId: user.id,
        sessionId: session.id,
        status: lateMinutes <= 60 ? "PRESENT" : "LATE",
        checkInTime: checkIn,
        checkOutTime: new Date(checkIn.getTime() + rand(45, 180) * 60_000),
        autoCheckedOut: !session.isToday && chance(0.2),
        createdAt: checkIn,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.attendance.createMany({ data: rows.slice(i, i + 500) });
  }

  // Anomalies + evidence (spread of types/severities, resolved/open).
  const TYPES = ["LIVENESS_FAILED", "LIVENESS_FAILED", "REPLAY_SUSPECTED", "DUPLICATE_DESCRIPTOR", "RAPID_ATTEMPTS"];
  const SEVERITIES = ["LOW", "MEDIUM", "MEDIUM", "HIGH"];
  const makeAnomaly = async ({ createdAt, type, severity, resolved, withEvidence }) => {
    const user = pick(users);
    const eventId = pick(demoEventIds);
    await prisma.anomalyFlag.create({
      data: {
        userId: user.id,
        eventId,
        type,
        severity,
        detail: { note: "demo anomaly" },
        resolvedAt: resolved ? new Date(createdAt.getTime() + rand(1, 48) * 3_600_000) : null,
        createdAt,
      },
    });
    if (withEvidence) {
      await prisma.attendanceEvidence.create({
        data: {
          userId: user.id,
          eventId,
          frameUrls: [],
          livenessScore: Number(rand(0.05, 0.6).toFixed(3)),
          matchDistance: Number(rand(0.35, 0.95).toFixed(3)),
          reason: "demo evidence",
          expiresAt: addUtcDays(today, 30),
          createdAt,
        },
      });
    }
  };
  for (let i = 0; i < 48; i += 1) {
    const createdAt = new Date(addUtcDays(today, -randInt(0, 44)).getTime() + rand(7, 21) * 3_600_000);
    if (createdAt > now) continue;
    await makeAnomaly({ createdAt, type: pick(TYPES), severity: pick(SEVERITIES), resolved: chance(0.6), withEvidence: chance(0.65) });
  }
  // A few HIGH, unresolved, from earlier today - so the live strip's open /
  // high-severity / today counters are always non-zero.
  for (let i = 0; i < 3; i += 1) {
    await makeAnomaly({
      createdAt: new Date(now.getTime() - rand(1, 6) * 3_600_000),
      type: "LIVENESS_FAILED",
      severity: "HIGH",
      resolved: false,
      withEvidence: true,
    });
  }

  logger.info({
    message: "Demo data seeded (idempotent, anchored to today)",
    demoEvents: demoEventIds.length,
    demoSessions: sessions.length,
    liveSessions: sessions.filter((s) => s.isLive).length,
    upcomingSessions: sessions.filter((s) => s.isFuture).length,
    attendanceRows: rows.length,
  });
}

main()
  .catch((e) => {
    logger.error(e, "Error during database seeding");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
