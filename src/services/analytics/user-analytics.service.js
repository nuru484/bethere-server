// src/services/analytics/user-analytics.service.js
//
// The attendant (USER) analytics: everything scoped to ONE signed-in user,
// answering "what do I do now, how am I doing, and how consistent am I" rather
// than the system-wide counts the legacy dashboard reports. Every function
// takes the authenticated userId; nothing crosses users.
import { Prisma } from "@prisma/client";
import ENV from "../../config/env.js";
import { prisma } from "../../config/prisma-client.js";
import { bucketedAttendance } from "../../utils/analytics-buckets.js";
import {
  buildBuckets,
  calculatePercentage,
  calculateTrend,
  resolveAnalyticsRange,
} from "../../utils/analytics-range.js";
import {
  addUtcDays,
  currentTimeStringInEventTz,
  eventCalendarDay,
} from "../../utils/time-context.js";

const EVENT_SELECT = {
  select: {
    id: true,
    title: true,
    type: true,
    startTime: true,
    endTime: true,
    location: { select: { name: true, city: true } },
  },
};

/** Present/late/absent/total from a userId-scoped groupBy(status). */
function countsFromGroups(groups) {
  const get = (status) => groups.find((g) => g.status === status)?._count._all ?? 0;
  const present = get("PRESENT");
  const late = get("LATE");
  const absent = get("ABSENT");
  return { present, late, absent, total: present + late + absent };
}

function userRangeWhere(userId, start, end) {
  return {
    userId,
    OR: [
      { checkInTime: { gte: start, lte: end } },
      { checkInTime: null, createdAt: { gte: start, lte: end } },
    ],
  };
}

/**
 * "Now / Next": the user's current check-in status and the next session they
 * can attend - the surface that connects the dashboard to the check-in action.
 */
export async function getUserNowNext(userId, now = new Date()) {
  const currentDate = eventCalendarDay(now);
  const startOfTomorrow = addUtcDays(currentDate, 1);
  const currentTimeString = currentTimeStringInEventTz(now);

  const [openAttendance, upcomingSessions] = await Promise.all([
    prisma.attendance.findFirst({
      where: {
        userId,
        checkInTime: { not: null },
        checkOutTime: null,
        session: { startDate: { lt: startOfTomorrow }, endDate: { gte: currentDate } },
      },
      orderBy: { checkInTime: "desc" },
      select: { checkInTime: true, sessionId: true, session: { select: { event: EVENT_SELECT } } },
    }),
    prisma.session.findMany({
      where: { endDate: { gte: currentDate } },
      orderBy: [{ startDate: "asc" }],
      take: 12,
      select: { id: true, startDate: true, endDate: true, event: EVENT_SELECT },
    }),
  ]);

  const annotate = (session) => {
    const coversToday =
      session.startDate.getTime() <= currentDate.getTime() &&
      session.endDate.getTime() >= currentDate.getTime();
    const isOpenNow =
      coversToday &&
      currentTimeString >= session.event.startTime &&
      currentTimeString <= session.event.endTime;
    return {
      sessionId: session.id,
      startDate: session.startDate,
      isToday: coversToday,
      isOpenNow,
      event: session.event,
    };
  };

  const annotated = upcomingSessions.map(annotate);
  const openNow = annotated.find((s) => s.isOpenNow);
  const next = openNow ?? annotated[0] ?? null;

  const checkedIn = openAttendance
    ? {
        sessionId: openAttendance.sessionId,
        checkInTime: openAttendance.checkInTime,
        event: openAttendance.session.event,
      }
    : null;

  return {
    checkedIn,
    next,
    canCheckIn: Boolean(next?.isOpenNow) && !checkedIn,
    upcoming: annotated.filter((s) => s.sessionId !== next?.sessionId).slice(0, 4),
  };
}

/** The user's headline KPIs with period-over-period trends and a streak. */
export async function getUserKpis(userId, params, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const { current, previous } = range;

  const [curStatus, prevStatus, streakRows] = await Promise.all([
    prisma.attendance.groupBy({
      by: ["status"],
      where: userRangeWhere(userId, current.start, current.end),
      _count: { _all: true },
    }),
    prisma.attendance.groupBy({
      by: ["status"],
      where: userRangeWhere(userId, previous.start, previous.end),
      _count: { _all: true },
    }),
    // Most-recent sessions first, to count the current attended streak.
    prisma.attendance.findMany({
      where: { userId },
      select: { status: true },
      orderBy: { session: { startTime: "desc" } },
      take: 200,
    }),
  ]);

  const cur = countsFromGroups(curStatus);
  const prev = countsFromGroups(prevStatus);
  const curAttended = cur.present + cur.late;
  const prevAttended = prev.present + prev.late;

  const attendanceRate = calculatePercentage(curAttended, cur.total);
  const prevAttendanceRate = calculatePercentage(prevAttended, prev.total);
  const onTimeRate = calculatePercentage(cur.present, curAttended);
  const prevOnTimeRate = calculatePercentage(prev.present, prevAttended);

  // Streak: consecutive most-recent sessions attended (present or late),
  // broken by the first missed (ABSENT) session.
  let streak = 0;
  for (const row of streakRows) {
    if (row.status === "PRESENT" || row.status === "LATE") streak += 1;
    else break;
  }

  return {
    range: { preset: range.preset, from: range.label.from, to: range.label.to, granularity: range.granularity },
    kpis: {
      attendanceRate: {
        value: attendanceRate,
        unit: "percent",
        trend: calculateTrend(attendanceRate, prevAttendanceRate),
        meta: { present: cur.present, late: cur.late, absent: cur.absent, total: cur.total },
      },
      onTimeRate: {
        value: onTimeRate,
        unit: "percent",
        trend: calculateTrend(onTimeRate, prevOnTimeRate),
        meta: { present: cur.present, attended: curAttended },
      },
      attended: {
        value: curAttended,
        unit: "count",
        trend: calculateTrend(curAttended, prevAttended),
        meta: { present: cur.present, late: cur.late },
      },
      currentStreak: { value: streak, unit: "count" },
    },
  };
}

/** The user's personal attendance time series. */
export async function getUserAttendanceTrend(userId, params, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const buckets = buildBuckets(range, range.granularity);

  const series = await bucketedAttendance({
    buckets,
    window: { start: range.current.start, end: range.current.end },
    extraWhere: Prisma.sql`a."userId" = ${userId}`,
  });

  const timeSeries = series.map((point) => ({
    label: point.label,
    present: point.present,
    late: point.late,
    absent: point.absent,
    total: point.total,
    attendanceRate: calculatePercentage(point.present + point.late, point.total),
  }));

  return {
    range: { preset: range.preset, from: range.label.from, to: range.label.to, granularity: range.granularity },
    timeSeries,
  };
}

/** The user's present/late/absent donut. */
export async function getUserStatusBreakdown(userId, params, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const groups = await prisma.attendance.groupBy({
    by: ["status"],
    where: userRangeWhere(userId, range.current.start, range.current.end),
    _count: { _all: true },
  });
  const c = countsFromGroups(groups);
  return {
    range: { preset: range.preset, from: range.label.from, to: range.label.to },
    segments: [
      { key: "PRESENT", label: "Present", count: c.present, percentage: calculatePercentage(c.present, c.total) },
      { key: "LATE", label: "Late", count: c.late, percentage: calculatePercentage(c.late, c.total) },
      { key: "ABSENT", label: "Absent", count: c.absent, percentage: calculatePercentage(c.absent, c.total) },
    ],
  };
}

/** The user's attendance rate per event they have records for. */
export async function getUserEventBreakdown(userId, params, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const { start, end } = range.current;

  const rows = await prisma.$queryRaw`
    SELECT
      e.id AS key,
      e.title AS label,
      COUNT(a.id)::int AS total,
      COUNT(a.id) FILTER (WHERE a.status::text = 'PRESENT')::int AS present,
      COUNT(a.id) FILTER (WHERE a.status::text = 'LATE')::int AS late,
      COUNT(a.id) FILTER (WHERE a.status::text = 'ABSENT')::int AS absent
    FROM "Attendance" a
    JOIN "Session" s ON a."sessionId" = s.id
    JOIN "Event" e ON s."eventId" = e.id
    WHERE a."userId" = ${userId}
      AND COALESCE(a."checkInTime", a."createdAt") >= ${start}
      AND COALESCE(a."checkInTime", a."createdAt") <= ${end}
    GROUP BY e.id, e.title
    ORDER BY total DESC
    LIMIT 10
  `;

  return {
    range: { preset: range.preset, from: range.label.from, to: range.label.to },
    segments: rows.map((row) => ({
      key: row.key,
      label: row.label,
      count: row.present + row.late,
      total: row.total,
      present: row.present,
      late: row.late,
      absent: row.absent,
      attendanceRate: calculatePercentage(row.present + row.late, row.total),
    })),
  };
}

/**
 * Per-day attendance status for the calendar heatmap: the best status the user
 * achieved each venue day (present > late > absent). Bucketed in venue time.
 */
export async function getUserCalendar(userId, params, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const { start, end } = range.current;
  const venueDay = Prisma.sql`to_char((COALESCE(a."checkInTime", a."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE ${ENV.EVENT_TIMEZONE}, 'YYYY-MM-DD')`;

  const rows = await prisma.$queryRaw`
    SELECT
      ${venueDay} AS date,
      COUNT(a.id) FILTER (WHERE a.status::text = 'PRESENT')::int AS present,
      COUNT(a.id) FILTER (WHERE a.status::text = 'LATE')::int AS late,
      COUNT(a.id) FILTER (WHERE a.status::text = 'ABSENT')::int AS absent,
      COUNT(a.id)::int AS total
    FROM "Attendance" a
    WHERE a."userId" = ${userId}
      AND COALESCE(a."checkInTime", a."createdAt") >= ${start}
      AND COALESCE(a."checkInTime", a."createdAt") <= ${end}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const days = rows.map((row) => ({
    date: row.date,
    status: row.present > 0 ? "present" : row.late > 0 ? "late" : "absent",
    present: row.present,
    late: row.late,
    absent: row.absent,
    total: row.total,
  }));

  return {
    range: { from: range.label.from, to: range.label.to },
    days,
  };
}
