import { Router } from 'express';

import { requireAdmin } from '../middlewares/require-admin.js';
import { getAdminDashboard } from '../services/admin-dashboard.svc.js';

export const adminRouter = Router();

export async function dashboardHandler(req, res, next, deps = {}) {
	const getDashboard = deps.getAdminDashboard ?? getAdminDashboard;
	try {
		const data = await getDashboard();
		res.json(data);
	}
	catch (err) {
		next(err);
	}
}

adminRouter.get('/dashboard', requireAdmin, (req, res, next) => dashboardHandler(req, res, next));
