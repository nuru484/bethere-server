// src/services/analytics/admin-engagement.service.js
//
// Engagement analytics: the top-attendees leaderboard and the recurring-event
// retention curve - a cohort view of whether the crowd that showed up for
// occurrence 1 keeps coming.
import { prisma } from "../../config/prisma-client.js";
import {
  calculatePercentage,
  resolveAnalyticsRange,
} from "../../utils/analytics-range.js";

/** A short YYYY-MM-DD from a date-only (UTC-midnight) session date. */
function dayLabel(dateOnly) {
  return new Date(dateOnly).toISOString().slice(0, 10);
}

/** Top attendees by turnout in the window, with attendance and punctuality rates. */
export async function getTopAttendees(params, limit = 10, now = new Date()) {
  const range = resolveAnalyticsRange(params, now);
  const { start, end } = range.current;
  const take = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const rows = await prisma.$queryRaw`
    SELECT
      a."userId" AS user_id,
      COUNT(a.id)::int AS total,
      COUNT(a.id) FILTER (WHERE a.status::text = 'PRESENT')::int AS present,
      COUNT(a.id) FILTER (WHERE a.status::text = 'LATE')::int AS late,
      COUNT(a.id) FILTER (WHERE a.status::text = 'ABSENT')::int AS absent
    FROM "Attendance" a
    WHERE COALESCE(a."checkInTime", a."createdAt") >= ${start}
      AND COALESCE(a."checkInTime", a."createdAt") <= ${end}
    GROUP BY a."userId"
    ORDER BY (COUNT(a.id) FILTER (WHERE a.status::text IN ('PRESENT','LATE'))) DESC,
             COUNT(a.id) FILTER (WHERE a.status::text = 'PRESENT') DESC
    LIMIT ${take}
  `;

  const userIds = rows.map((row) => row.user_id);
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true, profilePicture: true },
      })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));

  const leaderboard = rows.map((row, index) => {
    const user = userById.get(row.user_id);
    const showed = row.present + row.late;
    return {
      rank: index + 1,
      userId: row.user_id,
      name: user ? `${user.firstName} ${user.lastName}` : "Unknown attendee",
      email: user?.email ?? null,
      profilePicture: user?.profilePicture ?? null,
      attended: showed,
      present: row.present,
      late: row.late,
      absent: row.absent,
      total: row.total,
      attendanceRate: calculatePercentage(showed, row.total),
      onTimeRate: calculatePercentage(row.present, showed),
    };
  });

  return {
    range: { preset: range.preset, from: range.label.from, to: range.label.to },
    leaderboard,
  };
}

/**
 * Retention curve for a recurring event: of the cohort that attended the first
 * occurrence, what fraction returns for each subsequent one. Defaults to the
 * recurring event with the most sessions when no eventId is given, and always
 * returns the recurring-event list for the UI's selector.
 */
export async function getRetentionCurve(eventId) {
  const availableEvents = await prisma.event.findMany({
    where: { isRecurring: true },
    select: { id: true, title: true },
    orderBy: { startDate: "desc" },
    take: 50,
  });

  let event = null;
  if (eventId) {
    event = await prisma.event.findFirst({
      where: { id: eventId, isRecurring: true },
      select: { id: true, title: true },
    });
  }
  if (!event) {
    // Fall back to the recurring event with the most occurrences.
    const top = await prisma.$queryRaw`
      SELECT e.id, e.title, COUNT(s.id)::int AS sessions
      FROM "Event" e
      JOIN "Session" s ON s."eventId" = e.id
      WHERE e."isRecurring" = true AND e."deletedAt" IS NULL
      GROUP BY e.id, e.title
      ORDER BY sessions DESC
      LIMIT 1
    `;
    if (top[0]) event = { id: top[0].id, title: top[0].title };
  }

  if (!event) return { event: null, cohortSize: 0, availableEvents, occurrences: [] };

  const sessions = await prisma.session.findMany({
    where: { eventId: event.id },
    orderBy: { startDate: "asc" },
    take: 52,
    select: { id: true, startDate: true },
  });
  if (sessions.length === 0) {
    return { event, cohortSize: 0, availableEvents, occurrences: [] };
  }

  const sessionIds = sessions.map((session) => session.id);
  const attendances = await prisma.attendance.findMany({
    where: { sessionId: { in: sessionIds }, status: { in: ["PRESENT", "LATE"] } },
    select: { sessionId: true, userId: true },
  });

  const attendeesBySession = new Map(sessionIds.map((id) => [id, new Set()]));
  for (const row of attendances) {
    attendeesBySession.get(row.sessionId)?.add(row.userId);
  }

  const cohort = attendeesBySession.get(sessions[0].id) ?? new Set();
  const cohortSize = cohort.size;

  const occurrences = sessions.map((session, index) => {
    const attendees = attendeesBySession.get(session.id) ?? new Set();
    let retained = 0;
    for (const userId of attendees) {
      if (cohort.has(userId)) retained += 1;
    }
    return {
      occurrence: index + 1,
      date: dayLabel(session.startDate),
      totalAttendees: attendees.size,
      cohortRetained: retained,
      retentionRate: calculatePercentage(retained, cohortSize),
    };
  });

  return { event, cohortSize, availableEvents, occurrences };
}
