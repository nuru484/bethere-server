// src/services/attendance-query.service.js
//
// The three attendance list surfaces (per user, per event, per user+event)
// plus the shared filter builders they and the reports service reuse.
import { prisma } from "../config/prisma-client.js";
import {
  NotFoundError,
  ValidationError,
} from "../middleware/error-handler.js";
import { assertSelfOrAdmin } from "../utils/authorization.js";
import { eventDayRange } from "../utils/time-context.js";

/** Every attendance list row carries a minimal user and the full session chain. */
export const ATTENDANCE_LIST_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      profilePicture: true,
    },
  },
  session: {
    include: {
      event: {
        include: {
          location: true,
        },
      },
    },
  },
};

/**
 * Validates and normalizes a status filter (PRESENT/LATE/ABSENT).
 * Express parses `?status[]=X` (and `?status=a&status=b`) into an array, so a
 * non-string value must be rejected as a bad filter rather than crashing on
 * `.toUpperCase()`.
 */
export function parseStatusFilter(status) {
  const validStatuses = ["PRESENT", "LATE", "ABSENT"];
  if (typeof status !== "string" || !validStatuses.includes(status.toUpperCase())) {
    throw new ValidationError(
      "Invalid status. Must be one of: PRESENT, LATE, ABSENT"
    );
  }
  return status.toUpperCase();
}

/**
 * Normalizes a free-text search term. Same array hazard as the status filter:
 * `?search[]=x` arrives as an array, which is not a searchable term.
 * Returns undefined when there is nothing to search for.
 */
export function parseSearchFilter(search) {
  if (search === undefined || search === null) return undefined;
  if (typeof search !== "string") {
    throw new ValidationError("Invalid search term.");
  }
  const trimmed = search.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Check-in time range filter; the end date is inclusive (end of that day).
 * Day boundaries are VENUE-timezone instants: computing "end of day" on the
 * server's local clock would put the filter off by the host/venue offset at
 * both edges.
 */
export function checkInTimeRange(startDate, endDate) {
  if (!startDate && !endDate) return undefined;

  const { start, end } = eventDayRange(startDate, endDate);
  const range = {};
  if (start) range.gte = start;
  if (end) range.lte = end;
  return range;
}

function parseSessionIdFilter(sessionId) {
  if (isNaN(parseInt(sessionId))) {
    throw new ValidationError("Valid session ID is required.");
  }
  return parseInt(sessionId);
}

/**
 * The filter core shared by every attendance list: user, event (via the
 * session), status, session, and check-in date range. Callers layer their
 * endpoint-specific search clauses on top.
 */
export function buildAttendanceWhere({
  userId,
  eventId,
  status,
  sessionId,
  startDate,
  endDate,
}) {
  const whereClause = {};

  if (userId !== undefined) {
    whereClause.userId = userId;
  }

  if (eventId !== undefined) {
    whereClause.session = { eventId };
  }

  if (status) {
    whereClause.status = parseStatusFilter(status);
  }

  if (sessionId) {
    whereClause.sessionId = parseSessionIdFilter(sessionId);
  }

  const range = checkInTimeRange(startDate, endDate);
  if (range) {
    whereClause.checkInTime = range;
  }

  return whereClause;
}

/**
 * Admins are not attendants (separate principal), so "my attendance" for an
 * admin's own id has no User row and no records. That is an empty result,
 * not a missing resource - callers use this to skip the 404.
 */
function isAdminViewingSelf(actor, targetUserId) {
  return (
    actor?.role === "ADMIN" &&
    actor?.kind === "ADMIN" &&
    parseInt(actor?.id?.toString() || "0") === targetUserId
  );
}

const EMPTY_ATTENDANCE_PAGE = Object.freeze({ attendances: [], total: 0 });

async function findAttendancePage(whereClause, { skip, limit }) {
  const [attendances, total] = await Promise.all([
    prisma.attendance.findMany({
      where: whereClause,
      skip,
      take: limit,
      // nulls last: ABSENT rows have no check-in time, and Postgres would
      // otherwise float them to the top of every DESC-ordered list.
      orderBy: {
        checkInTime: { sort: "desc", nulls: "last" },
      },
      include: ATTENDANCE_LIST_INCLUDE,
    }),
    prisma.attendance.count({ where: whereClause }),
  ]);

  return { attendances, total };
}

/** A user's attendance across events; owner-or-admin. */
export async function listUserAttendance(
  actor,
  userId,
  { skip, limit, search, status, eventType, startDate, endDate }
) {
  assertSelfOrAdmin(
    actor,
    userId,
    "Only admins can access other users' attendance."
  );

  const user = await prisma.user.findFirst({ where: { id: userId } });

  if (!user) {
    if (isAdminViewingSelf(actor, userId)) {
      return EMPTY_ATTENDANCE_PAGE;
    }
    throw new NotFoundError(`User with ID ${userId} not found.`);
  }

  const whereClause = buildAttendanceWhere({
    userId,
    status,
    startDate,
    endDate,
  });

  // Search across event title, description, type, and location
  const searchTerm = parseSearchFilter(search);
  if (searchTerm) {
    whereClause.session = {
      event: {
        OR: [
          { title: { contains: searchTerm, mode: "insensitive" } },
          { description: { contains: searchTerm, mode: "insensitive" } },
          { type: { contains: searchTerm, mode: "insensitive" } },
          {
            location: {
              OR: [
                { name: { contains: searchTerm, mode: "insensitive" } },
                { city: { contains: searchTerm, mode: "insensitive" } },
                { country: { contains: searchTerm, mode: "insensitive" } },
              ],
            },
          },
        ],
      },
    };
  }

  // Filter by event type
  if (eventType) {
    if (!whereClause.session) {
      whereClause.session = {};
    }
    if (whereClause.session.event) {
      whereClause.session.event.type = eventType;
    } else {
      whereClause.session.event = { type: eventType };
    }
  }

  return findAttendancePage(whereClause, { skip, limit });
}

/** An event's attendance across users; admin route. */
export async function listEventAttendance(
  eventId,
  { skip, limit, search, status, sessionId, startDate, endDate }
) {
  // findFirst: a soft-deleted event reads as absent.
  const event = await prisma.event.findFirst({ where: { id: eventId } });

  if (!event) {
    throw new NotFoundError(`Event with ID ${eventId} not found.`);
  }

  const whereClause = buildAttendanceWhere({
    eventId,
    status,
    sessionId,
    startDate,
    endDate,
  });

  // One search box covers attendant details AND, when the term is a plain
  // number, the session id - so the separate session filter is optional.
  const searchTerm = parseSearchFilter(search);
  if (searchTerm) {
    const userMatch = {
      user: {
        OR: [
          { firstName: { contains: searchTerm, mode: "insensitive" } },
          { lastName: { contains: searchTerm, mode: "insensitive" } },
          { email: { contains: searchTerm, mode: "insensitive" } },
        ],
      },
    };

    const numericSearch = /^\d+$/.test(searchTerm)
      ? parseInt(searchTerm, 10)
      : null;

    whereClause.AND = [
      ...(whereClause.AND ?? []),
      numericSearch !== null
        ? { OR: [userMatch, { sessionId: numericSearch }] }
        : userMatch,
    ];
  }

  return findAttendancePage(whereClause, { skip, limit });
}

/** One user's attendance within one event; owner-or-admin. */
export async function listUserEventAttendance(
  actor,
  userId,
  eventId,
  { skip, limit, status, sessionId, startDate, endDate }
) {
  assertSelfOrAdmin(
    actor,
    userId,
    "Only admins can access other users' attendance."
  );

  const user = await prisma.user.findFirst({ where: { id: userId } });

  if (!user && !isAdminViewingSelf(actor, userId)) {
    throw new NotFoundError(`User with ID ${userId} not found.`);
  }

  const event = await prisma.event.findFirst({ where: { id: eventId } });

  if (!event) {
    throw new NotFoundError(`Event with ID ${eventId} not found.`);
  }

  if (!user) {
    // Admin viewing their own (nonexistent) attendance for a real event.
    return EMPTY_ATTENDANCE_PAGE;
  }

  const whereClause = buildAttendanceWhere({
    userId,
    eventId,
    status,
    sessionId,
    startDate,
    endDate,
  });

  return findAttendancePage(whereClause, { skip, limit });
}
