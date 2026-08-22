// src/routes/dashboard/user-analytics.js
//
// The attendant analytics slices. Each widget on the personal
// dashboard is its own endpoint, all scoped to the signed-in user. Mounted
// under /dashboard/users alongside the legacy totals/attendance-data routes.
import { Router } from "express";
import { authenticateJWT } from "../../middleware/jwt-authentication.js";
import { authorizeRole } from "../../middleware/authorize-role.js";
import {
  getUserAttendanceTrend,
  getUserCalendar,
  getUserEventBreakdown,
  getUserKpis,
  getUserNowNext,
  getUserStatusBreakdown,
} from "../../controllers/dashboard/user-analytics.js";

const router = Router();

router.use(authenticateJWT, authorizeRole(["USER"]));

router.get("/now-next", getUserNowNext);
router.get("/kpis", getUserKpis);
router.get("/attendance-trend", getUserAttendanceTrend);
router.get("/status-breakdown", getUserStatusBreakdown);
router.get("/event-breakdown", getUserEventBreakdown);
router.get("/calendar", getUserCalendar);

export default router;
