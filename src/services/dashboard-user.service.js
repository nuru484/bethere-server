// src/services/dashboard-user.service.js
//
// User-facing dashboard aggregations: event/session totals, the recent
// events strip, and the per-user attendance time series.
import { differenceInCalendarDays } from "date-fns";
import { prisma } from "../config/prisma-client.js";
import {
  BadRequestError,
  ValidationError,
} from "../middleware/error-handler.js";
import {
  addUtcDays,
  currentTimeStringInEventTz,
  eventCalendarDay,
  eventDayKey,
  eventDayRange,
} from "../utils/time-context.js";

/**
 * Widest range the dashboards will aggregate. The per-day series still
 * fetches one slim row per attendance in range, so the range is what bounds
 * memory - beyond a year-and-change of charts there is no dashboard use case,
 * only an unbounded query.
 */
export const MAX_DASHBOARD_RANGE_DAYS = 400;

/** Event and session totals, with active sessions counted for right now. */
export async function getUserDashboardTotals() {
  const now = new Date();
  // The VENUE's calendar day, matching how session rows are keyed - the
  // server's local midnight disagrees with it whenever host and venue
  // timezones differ.
  const currentDate = eventCalendarDay(now);

  const currentTimeString = currentTimeStringInEventTz(now);

  // Sessions whose date range covers today. Filtering in SQL keeps this
  // bounded, rather than loading EVERY session row plus its event into memory
  // just to count the active ones; only the time-window check runs in JS
  // because start/end times are "HH:MM" strings on the event.
  const startOfTomorrow = addUtcDays(currentDate, 1);

  const [
    totalRecurringEvents,
    totalNonRecurringEvents,
    totalSessions,
    todaysSessions,
  ] = await Promise.all([
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

    prisma.session.count(),

    prisma.session.findMany({
      where: {
        startDate: { lt: startOfTomorrow },
        endDate: { gte: currentDate },
      },
      select: {
        event: { select: { startTime: true, endTime: true } },
      },
    }),
  ]);

  const totalActiveSessions = todaysSessions.filter(
    (session) =>
      currentTimeString >= session.event.startTime &&
      currentTimeString <= session.event.endTime
  ).length;
  const totalInactiveSessions = totalSessions - totalActiveSessions;

  return {
    totalRecurringEvents,
    totalNonRecurringEvents,
    totalActiveSessions,
    totalInactiveSessions,
  };
}

/** The five most recently created events, trimmed for the dashboard strip. */
export async function getRecentEvents() {
  return prisma.event.findMany({
    take: 5,
    orderBy: {
      createdAt: "desc",
    },
    select: {
      title: true,
      description: true,
      startTime: true,
      endTime: true,
      location: {
        select: {
          name: true,
          city: true,
        },
      },
    },
  });
}

/**
 * Validates a YYYY-MM-DD range and returns its day-precision endpoints as
 * VENUE-timezone instants, so a "day" here means the same thing it means at
 * check-in time.
 */
export function parseDateRange(startDate, endDate) {
  if (!startDate || !endDate) {
    throw new ValidationError("Both startDate and endDate are required.");
  }

  if (
    isNaN(new Date(startDate).getTime()) ||
    isNaN(new Date(endDate).getTime())
  ) {
    throw new ValidationError("Invalid date format. Use YYYY-MM-DD format.");
  }

  const { start } = eventDayRange(startDate, undefined);
  const { end } = eventDayRange(undefined, endDate);

  if (start > end) {
    throw new ValidationError("startDate cannot be after endDate.");
  }

  if (differenceInCalendarDays(end, start) > MAX_DASHBOARD_RANGE_DAYS) {
    throw new BadRequestError(
      `Date range too large. Maximum is ${MAX_DASHBOARD_RANGE_DAYS} days.`
    );
  }

  return { start, end };
}

/** One user's attendance in a date range, grouped by day with a summary. */
export async function getUserAttendanceData(userId, startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate);

  // ABSENT rows (written by the session finalizer) have no checkInTime;
  // they enter the range by their creation instant instead, which lands on
  // (or just after) the finalized session's day.
  const rangeWhere = {
    userId,
    OR: [
      { checkInTime: { gte: start, lte: end } },
      { checkInTime: null, createdAt: { gte: start, lte: end } },
    ],
  };

  // Summary numbers aggregate in SQL (groupBy/count); only the per-day
  // series still walks rows, because its day bucket needs a date-truncated
  // key that Prisma groupBy cannot express without raw SQL. Those rows carry
  // just four small values each, and parseDateRange caps the range, so the
  // walk stays memory-bounded: no full session rows per attendance, and no
  // recounting the same rows in JS five times over.
  const [statusGroups, recurringCount, nonRecurringCount, attendances] =
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
      prisma.attendance.findMany({
        where: rangeWhere,
        select: {
          status: true,
          checkInTime: true,
          session: {
            select: {
              event: {
                select: {
                  title: true,
                  isRecurring: true,
                },
              },
            },
          },
        },
        orderBy: {
          checkInTime: "asc",
        },
      }),
    ]);

  const statusCount = (status) =>
    statusGroups.find((group) => group.status === status)?._count._all ?? 0;
  const totalAttendances = statusGroups.reduce(
    (sum, group) => sum + group._count._all,
    0
  );

  const attendanceByDate = {};

  attendances.forEach((attendance) => {
    // ABSENT rows have no check-in; bucket them on the day the row was
    // written (the finalized session day). Day keys are venue-timezone.
    const date = eventDayKey(attendance.checkInTime ?? attendance.createdAt);

    if (!attendanceByDate[date]) {
      attendanceByDate[date] = {
        date,
        total: 0,
        present: 0,
        late: 0,
        absent: 0,
        recurringEvents: 0,
        nonRecurringEvents: 0,
        events: [],
      };
    }

    attendanceByDate[date].total++;

    // Count by status
    if (attendance.status === "PRESENT") {
      attendanceByDate[date].present++;
    } else if (attendance.status === "LATE") {
      attendanceByDate[date].late++;
    } else if (attendance.status === "ABSENT") {
      attendanceByDate[date].absent++;
    }

    // Count by event type
    if (attendance.session.event.isRecurring) {
      attendanceByDate[date].recurringEvents++;
    } else {
      attendanceByDate[date].nonRecurringEvents++;
    }

    // Track unique events
    if (
      !attendanceByDate[date].events.includes(attendance.session.event.title)
    ) {
      attendanceByDate[date].events.push(attendance.session.event.title);
    }
  });

  // Convert to array and sort by date
  const attendanceData = Object.values(attendanceByDate).sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  // Calculate summary statistics
  const summary = {
    totalAttendances,
    dateRange: {
      from: eventDayKey(start),
      to: eventDayKey(end),
    },
    statusBreakdown: {
      present: statusCount("PRESENT"),
      late: statusCount("LATE"),
      absent: statusCount("ABSENT"),
    },
    eventTypeBreakdown: {
      recurring: recurringCount,
      nonRecurring: nonRecurringCount,
    },
  };

  return {
    summary,
    attendanceByDate: attendanceData,
  };
}
