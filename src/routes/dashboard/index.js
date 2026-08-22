import { Router } from "express";
const router = Router();

import userDashboardRoutes from "./users.js";
import userAnalyticsRoutes from "./user-analytics.js";
import adminDashboardRoutes from "./admin.js";
import adminAnalyticsRoutes from "./admin-analytics.js";

router.use("/users", userDashboardRoutes);
// The attendant analytics slices share the /users prefix; distinct
// paths keep them from colliding with the legacy routes.
router.use("/users", userAnalyticsRoutes);
router.use("/admin", adminDashboardRoutes);
// The admin analytics slices share the /admin prefix; distinct
// paths (/live, /kpis, ...) keep them from colliding with the legacy routes.
router.use("/admin", adminAnalyticsRoutes);

export default router;
