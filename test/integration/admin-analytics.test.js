// test/integration/admin-analytics.test.js
//
// The admin analytics slices: hero KPIs (presence/punctuality/
// integrity with trends), the live snapshot, the presence time series with a
// previous-period overlay, and the categorical breakdowns - all against the
// same deterministic seed, plus the role gate.
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../src/config/prisma-client.js";
import {
  adminCookie,
  attendantCookie,
  createAdmin,
  createAttendant,
} from "../helpers.js";

const D1 = "2026-03-10";
const D2 = "2026-03-11";
const utc = (iso) => new Date(`${iso}T00:00:00.000Z`);
const noon = (iso) => new Date(`${iso}T12:00:00.000Z`);

async function createEventWithSessions({ title, isRecurring, days }) {
  const location = await prisma.location.create({ data: { name: `${title} Hall` } });
  const event = await prisma.event.create({
    data: {
      title,
      startDate: utc(days[0]),
      endDate: utc(days.at(-1)),
      isRecurring,
      startTime: "09:00",
      endTime: "17:00",
      locationId: location.id,
      type: "MEETING",
    },
  });
  const sessions = {};
  for (const day of days) {
    sessions[day] = await prisma.session.create({
      data: {
        eventId: event.id,
        startDate: utc(day),
        endDate: utc(day),
        startTime: noon(day), // scheduled open at 12:00
        endTime: noon(day),
      },
    });
  }
  return { event, sessions };
}

/**
 *   D1: userA PRESENT@12:00 (recurring), userB LATE@12:05 (recurring),
 *       userB ABSENT@12:10 (one-off)
 *   D2: userA PRESENT@12:00 (recurring)
 * Lateness vs the 12:00 open: 0, 5, 10, 0 -> mean 3.75 min.
 */
async function seed() {
  const admin = await createAdmin();
  const userA = await createAttendant({ email: "a@test.local" });
  const userB = await createAttendant({ email: "b@test.local" });

  const recurring = await createEventWithSessions({
    title: "Recurring Event",
    isRecurring: true,
    days: [D1, D2],
  });
  const oneOff = await createEventWithSessions({
    title: "One-off Event",
    isRecurring: false,
    days: [D1],
  });

  await prisma.attendance.createMany({
    data: [
      { userId: userA.id, sessionId: recurring.sessions[D1].id, status: "PRESENT", checkInTime: noon(D1) },
      { userId: userB.id, sessionId: recurring.sessions[D1].id, status: "LATE", checkInTime: new Date(`${D1}T12:05:00.000Z`) },
      { userId: userB.id, sessionId: oneOff.sessions[D1].id, status: "ABSENT", checkInTime: new Date(`${D1}T12:10:00.000Z`) },
      { userId: userA.id, sessionId: recurring.sessions[D2].id, status: "PRESENT", checkInTime: noon(D2) },
    ],
  });

  return { admin, userA, userB };
}

const range = `startDate=${D1}&endDate=${D2}`;

describe("GET /dashboard/admin/kpis", () => {
  it("computes presence, punctuality, and integrity KPIs with trends", async () => {
    const { admin } = await seed();

    const res = await request(app)
      .get(`/api/v1/dashboard/admin/kpis?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const { kpis, range: r } = res.body.data;

    expect(r).toMatchObject({ from: D1, to: D2, granularity: "day" });

    // 3 of 4 showed up (present+late) -> 75%
    expect(kpis.attendanceRate.value).toBe(75);
    expect(kpis.attendanceRate.meta).toEqual({ present: 2, late: 1, absent: 1, total: 4 });
    // 2 of the 3 who showed were on time -> 66.67%
    expect(kpis.punctualityRate.value).toBeCloseTo(66.67, 2);
    expect(kpis.uniqueAttendees.value).toBe(2);
    expect(kpis.avgLateness.value).toBeCloseTo(3.8, 5); // mean 3.75 -> 1dp
    expect(kpis.avgLateness.inverse).toBe(true);
    expect(kpis.anomalies.value).toBe(0);
    expect(kpis.anomalies.meta.open).toBe(0);
    // no previous-period data -> every metric trends up from zero baseline
    expect(kpis.attendanceRate.trend).toEqual({ direction: "upward", percentage: 100 });
    expect(kpis.enrollmentCoverage.meta.totalUsers).toBe(2);
  });

  it("is not readable by an attendant", async () => {
    const { userA } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/kpis?${range}`)
      .set("Cookie", [attendantCookie(userA)]);
    expect(res.status).toBe(403);
  });
});

describe("GET /dashboard/admin/live", () => {
  it("returns a zeroed snapshot when nothing is scheduled today", async () => {
    const { admin } = await seed(); // all sessions are in March, not 'today'

    const res = await request(app)
      .get("/api/v1/dashboard/admin/live")
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sessionsToday: 0,
      sessionsLiveNow: 0,
      checkedInNow: 0,
      checkInsToday: 0,
      openAnomalies: 0,
      anomaliesToday: 0,
    });
    expect(typeof res.body.data.asOf).toBe("string");
  });
});

describe("GET /dashboard/admin/presence-trend", () => {
  it("buckets attendance by day with a rate and a previous-period overlay", async () => {
    const { admin } = await seed();

    const res = await request(app)
      .get(`/api/v1/dashboard/admin/presence-trend?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const { timeSeries, summary } = res.body.data;

    expect(timeSeries).toHaveLength(2);
    expect(timeSeries[0]).toMatchObject({
      label: D1,
      present: 1,
      late: 1,
      absent: 1,
      total: 3,
      uniqueUsers: 2,
      previousTotal: 0, // preceding 2-day window is empty
    });
    expect(timeSeries[0].attendanceRate).toBeCloseTo(66.67, 2);
    expect(timeSeries[1]).toMatchObject({ label: D2, present: 1, total: 1, previousTotal: 0 });
    expect(summary).toMatchObject({ present: 2, late: 1, absent: 1, total: 4 });
  });
});

describe("GET /dashboard/admin/presence-breakdown", () => {
  it("breaks down by status", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/presence-breakdown?by=status&${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    expect(res.body.data.by).toBe("status");
    const byKey = Object.fromEntries(res.body.data.segments.map((s) => [s.key, s]));
    expect(byKey.PRESENT).toMatchObject({ count: 2, percentage: 50 });
    expect(byKey.LATE).toMatchObject({ count: 1, percentage: 25 });
    expect(byKey.ABSENT).toMatchObject({ count: 1, percentage: 25 });
  });

  it("breaks down by event type", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/presence-breakdown?by=eventType&${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.segments.map((s) => [s.key, s]));
    expect(byKey.recurring.count).toBe(3);
    expect(byKey.nonRecurring.count).toBe(1);
  });

  it("breaks down by event and by location", async () => {
    const { admin } = await seed();

    const byEvent = await request(app)
      .get(`/api/v1/dashboard/admin/presence-breakdown?by=event&${range}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(byEvent.status).toBe(200);
    const events = Object.fromEntries(byEvent.body.data.segments.map((s) => [s.label, s.count]));
    expect(events["Recurring Event"]).toBe(3);
    expect(events["One-off Event"]).toBe(1);

    const byLoc = await request(app)
      .get(`/api/v1/dashboard/admin/presence-breakdown?by=location&${range}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(byLoc.status).toBe(200);
    const locs = Object.fromEntries(byLoc.body.data.segments.map((s) => [s.label, s.count]));
    expect(locs["Recurring Event Hall"]).toBe(3);
    expect(locs["One-off Event Hall"]).toBe(1);
  });
});

describe("GET /dashboard/admin/punctuality-trend", () => {
  it("splits on-time vs late per day with mean lateness", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/punctuality-trend?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const [d1, d2] = res.body.data.timeSeries;
    // D1: PRESENT@0min on time, LATE@5min; ABSENT@10min counts toward mean only
    expect(d1).toMatchObject({ label: D1, onTime: 1, late: 1, onTimeRate: 50 });
    expect(d1.avgLateness).toBeCloseTo(5, 5); // mean of 0,5,10
    expect(d2).toMatchObject({ label: D2, onTime: 1, late: 0, onTimeRate: 100 });
  });
});

describe("GET /dashboard/admin/lateness-distribution", () => {
  it("bins arrivals by minutes late", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/lateness-distribution?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.segments.map((s) => [s.key, s.count]));
    expect(res.body.data.total).toBe(4);
    expect(byKey.on_time).toBe(2); // the two 0-min arrivals
    expect(byKey.m0_5).toBe(1); // the 5-min
    expect(byKey.m5_15).toBe(1); // the 10-min
  });
});

describe("GET /dashboard/admin/arrival-heatmap", () => {
  it("counts check-ins by venue day-of-week and hour", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/arrival-heatmap?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.maxCount).toBe(3);
    // 2026-03-10 = Tue (DOW 2) x3 @12h, 2026-03-11 = Wed (DOW 3) x1 @12h
    const cell = (dow, hour) =>
      res.body.data.cells.find((c) => c.dow === dow && c.hour === hour)?.count ?? 0;
    expect(cell(2, 12)).toBe(3);
    expect(cell(3, 12)).toBe(1);
  });
});

describe("GET /dashboard/admin/integrity-summary (clean)", () => {
  it("scores a perfect 100 when there are no anomalies", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/integrity-summary?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    expect(res.body.data.integrityScore).toMatchObject({ score: 100, grade: "A" });
    expect(res.body.data.summary).toMatchObject({
      totalAnomalies: 0,
      anomalyRate: 0,
      successfulCheckins: 3, // 2 present + 1 late (absent excluded)
    });
  });
});

async function seedWithAnomalies() {
  const base = await seed();
  const event = await prisma.event.findFirst();
  await prisma.anomalyFlag.createMany({
    data: [
      { userId: base.userB.id, eventId: event.id, type: "LIVENESS_FAILED", severity: "HIGH", createdAt: noon(D1) },
      {
        userId: base.userB.id,
        eventId: event.id,
        type: "REPLAY_SUSPECTED",
        severity: "MEDIUM",
        createdAt: noon(D1),
        resolvedAt: new Date(`${D1}T14:00:00.000Z`), // 2h to resolve
      },
    ],
  });
  await prisma.attendanceEvidence.create({
    data: {
      userId: base.userB.id,
      eventId: event.id,
      frameUrls: [],
      livenessScore: 0.3,
      matchDistance: 0.7,
      expiresAt: new Date(`${D2}T00:00:00.000Z`),
      createdAt: noon(D1),
    },
  });
  return base;
}

describe("integrity analytics with anomalies", () => {
  it("computes the composite score, MTTR, and breakdowns", async () => {
    const { admin } = await seedWithAnomalies();

    const summary = await request(app)
      .get(`/api/v1/dashboard/admin/integrity-summary?${range}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(summary.status).toBe(200);
    // cleanliness=(1-2/5)*100=60 (*.55), resolution=50 (*.15), liveness=30 (*.30) -> 50
    expect(summary.body.data.integrityScore.score).toBe(50);
    expect(summary.body.data.integrityScore.grade).toBe("F");
    expect(summary.body.data.summary).toMatchObject({
      totalAnomalies: 2,
      resolvedAnomalies: 1,
      resolutionRate: 50,
      successfulCheckins: 3,
      attempts: 5,
    });
    expect(summary.body.data.summary.mttrHours).toBeCloseTo(2, 5);

    const trend = await request(app)
      .get(`/api/v1/dashboard/admin/anomaly-trend?${range}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(trend.body.data.timeSeries[0]).toMatchObject({
      label: D1,
      total: 2,
      livenessFailed: 1,
      replaySuspected: 1,
    });

    const byType = await request(app)
      .get(`/api/v1/dashboard/admin/anomaly-breakdown?by=type&${range}`)
      .set("Cookie", [adminCookie(admin)]);
    const types = Object.fromEntries(byType.body.data.segments.map((s) => [s.key, s]));
    expect(types.LIVENESS_FAILED.count).toBe(1);
    expect(types.REPLAY_SUSPECTED).toMatchObject({ count: 1, resolved: 1 });

    const quality = await request(app)
      .get(`/api/v1/dashboard/admin/liveness-quality?${range}`)
      .set("Cookie", [adminCookie(admin)]);
    expect(quality.body.data.livenessScore.average).toBeCloseTo(0.3, 5);
    expect(quality.body.data.matchDistance.average).toBeCloseTo(0.7, 5);
    const scoreBins = Object.fromEntries(
      quality.body.data.livenessScore.bins.map((b) => [b.label, b.count])
    );
    expect(scoreBins["0.2-0.4"]).toBe(1);
  });
});

describe("GET /dashboard/admin/top-attendees", () => {
  it("ranks attendees by turnout with rates", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get(`/api/v1/dashboard/admin/top-attendees?${range}`)
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const [first, second] = res.body.data.leaderboard;
    // userA showed up twice (both present); userB once (late) + one absent
    expect(first).toMatchObject({ rank: 1, attended: 2, present: 2, attendanceRate: 100, onTimeRate: 100 });
    expect(second).toMatchObject({ rank: 2, attended: 1, late: 1, absent: 1 });
  });
});

describe("GET /dashboard/admin/retention-curve", () => {
  it("computes cohort retention across a recurring event's occurrences", async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get("/api/v1/dashboard/admin/retention-curve")
      .set("Cookie", [adminCookie(admin)]);

    expect(res.status).toBe(200);
    const { event, cohortSize, occurrences } = res.body.data;
    expect(event.title).toBe("Recurring Event");
    expect(cohortSize).toBe(2); // userA + userB attended occurrence 1
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]).toMatchObject({ occurrence: 1, cohortRetained: 2, retentionRate: 100 });
    // occurrence 2 (D2): only userA returns -> 1 of 2 retained
    expect(occurrences[1]).toMatchObject({ occurrence: 2, totalAttendees: 1, cohortRetained: 1, retentionRate: 50 });
  });
});
