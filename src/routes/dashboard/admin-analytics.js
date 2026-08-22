// src/routes/dashboard/admin-analytics.js
//
// The admin analytics slices. Each card/chart on the admin
// dashboard is its own endpoint (the "slice" pattern), so the page fills in
// progressively and one failing widget never blanks the board. Mounted under
// /dashboard/admin alongside the legacy totals/attendance-data routes.
import { Router } from "express";
import { authenticateJWT } from "../../middleware/jwt-authentication.js";
import { authorizeRole } from "../../middleware/authorize-role.js";
import {
  getAdminAiSummary,
  getAdminKpis,
  getAdminLiveSnapshot,
  getAnomalyBreakdown,
  getAnomalyTrend,
  getArrivalHeatmap,
  getIntegritySummary,
  getLatenessDistribution,
  getLivenessQuality,
  getPresenceBreakdown,
  getPresenceTrend,
  getPunctualityTrend,
  getRetentionCurve,
  getTopAttendees,
} from "../../controllers/dashboard/admin-analytics.js";

const router = Router();

// Every analytics slice is admin-only.
router.use(authenticateJWT, authorizeRole(["ADMIN"]));

// Live operational snapshot ("now" strip) - never date-filtered.
router.get("/live", getAdminLiveSnapshot);

// Hero KPI row with period-over-period trends.
router.get("/kpis", getAdminKpis);

// Attendance time series (present/late/absent + rate + previous overlay).
router.get("/presence-trend", getPresenceTrend);

// Categorical breakdown: ?by=status|eventType|event|location.
router.get("/presence-breakdown", getPresenceBreakdown);

// Punctuality: on-time-vs-late trend, lateness histogram, arrival heatmap.
router.get("/punctuality-trend", getPunctualityTrend);
router.get("/lateness-distribution", getLatenessDistribution);
router.get("/arrival-heatmap", getArrivalHeatmap);

// Integrity: anomaly trend/breakdown, liveness quality, composite score.
router.get("/anomaly-trend", getAnomalyTrend);
router.get("/anomaly-breakdown", getAnomalyBreakdown);
router.get("/liveness-quality", getLivenessQuality);
router.get("/integrity-summary", getIntegritySummary);

// Engagement: top-attendee leaderboard and recurring-event retention curve.
router.get("/top-attendees", getTopAttendees);
router.get("/retention-curve", getRetentionCurve);

// AI narrative: an aggregate-only, PII-firewalled period summary.
router.post("/ai-summary", getAdminAiSummary);

export default router;
