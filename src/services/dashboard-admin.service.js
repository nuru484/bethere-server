// src/services/dashboard-admin.service.js
//
// Admin dashboard aggregations: platform totals and the all-users
// attendance time series with status breakdowns.
import { Prisma } from "@prisma/client";
import ENV from "../config/env.js";
import { prisma } from "../config/prisma-client.js";
import { eventDayKey } from "../utils/time-context.js";
import { parseDateRange } from "./dashboard-user.service.js";

/** User and event totals for the admin landing cards. */
export async function getAdminDashboardTotals() {
  const [totalUsers, totalRecurringEvents, totalNonRecurringEvents] =
    await Promise.all([
      prisma.user.count(),

      prisma.event.count({
        where: {
          isRecurring: true,
        },
      }),

      prisma.event.count({
        where: {
          isRecurring: false,
        },
      }),
    ]);

  return {
    totalUsers,
    totalRecurringEvents,
    totalNonRecurringEvents,
    totalEvents: totalRecurringEvents + totalNonRecurringEvents,
  };
}

/** Everyone's attendance in a date range, shaped for the admin charts. */
export async function getAllUsersAttendanceData(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate);

  // ABSENT rows (written by the session finalizer) have no checkInTime; they
  // enter the range by their creation instant, which lands on (or just
  // after) the finalized session's day.
  const rangeWhere = {
    OR: [
      { checkInTime: { gte: start, lte: end } },
      { checkInTime: null, createdAt: { gte: start, lte: end } },
    ],
  };

  // Every number aggregates in SQL. The per-day series is a raw GROUP BY on
  // the venue-timezone day: materializing EVERY attendance row in range into
  // memory would be millions of rows on the hot admin landing page at
  // thousands of users (the range caps days, not rows), and bucketing by the
  // SERVER's local day would disagree with the check-in path's venue-day
  // discipline.
  const effectiveInstant = Prisma.sql`COALESCE("checkInTime", "createdAt")`;
  const venueDay = Prisma.sql`to_char((${effectiveInstant} AT TIME ZONE 'UTC') AT TIME ZONE ${ENV.EVENT_TIMEZONE}, 'YYYY-MM-DD')`;

  const [statusGroups, recurringCount, nonRecurringCount, dayRows, distinctUsers] =
    await Promise.all([
      prisma.attendance.groupBy({
        by: ["status"],
        where: rangeWhere,
        _count: { _all: true },
      }),
      prisma.attendance.count({
        where: { ...rangeWhere, session: { event: { isRecurring: true } } },
      }),
      prisma.attendance.count({
        where: { ...rangeWhere, session: { event: { isRecurring: false } } },
      }),
      prisma.$queryRaw`
        SELECT
          ${venueDay} AS date,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status::text = 'PRESENT')::int AS present,
          COUNT(*) FILTER (WHERE status::text = 'LATE')::int AS late,
          COUNT(*) FILTER (WHERE status::text = 'ABSENT')::int AS absent,
          COUNT(DISTINCT "userId")::int AS "uniqueUsers"
        FROM "Attendance"
        WHERE ${effectiveInstant} >= ${start} AND ${effectiveInstant} <= ${end}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prisma.attendance.groupBy({
        by: ["userId"],
        where: rangeWhere,
      }),
    ]);

  const statusCount = (status) =>
    statusGroups.find((group) => group.status === status)?._count._all ?? 0;

  const timeSeriesData = dayRows.map((day) => ({
    date: day.date,
    total: day.total,
    present: day.present,
    late: day.late,
    absent: day.absent,
    uniqueUsers: day.uniqueUsers,
  }));

  // Overall statistics for bar chart (percentages), from the SQL groupBy.
  const totalAttendances = statusGroups.reduce(
    (sum, group) => sum + group._count._all,
    0
  );
  const presentCount = statusCount("PRESENT");
  const lateCount = statusCount("LATE");
  const absentCount = statusCount("ABSENT");

  const statusPercentages = {
    present:
      totalAttendances > 0
        ? ((presentCount / totalAttendances) * 100).toFixed(2)
        : "0.00",
    late:
      totalAttendances > 0
        ? ((lateCount / totalAttendances) * 100).toFixed(2)
        : "0.00",
    absent:
      totalAttendances > 0
        ? ((absentCount / totalAttendances) * 100).toFixed(2)
        : "0.00",
  };

  const statusCounts = {
    present: presentCount,
    late: lateCount,
    absent: absentCount,
    total: totalAttendances,
  };

  // Calculate additional insights
  const uniqueUsersAttended = distinctUsers.length;
  const recurringEventAttendances = recurringCount;
  const nonRecurringEventAttendances = nonRecurringCount;

  // Summary statistics
  const summary = {
    dateRange: {
      from: eventDayKey(start),
      to: eventDayKey(end),
    },
    totalAttendances,
    uniqueUsersAttended,
    statusCounts,
    statusPercentages,
    eventTypeBreakdown: {
      recurring: recurringEventAttendances,
      nonRecurring: nonRecurringEventAttendances,
    },
  };

  return {
    summary,
    timeSeriesData, // For line chart: attendance over time
    statusPercentages, // For bar chart: percentage breakdown
    statusCounts, // For bar chart: actual counts
  };
}
