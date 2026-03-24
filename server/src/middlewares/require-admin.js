export function requireAdmin(req, res, next) {
	if (!req.isAuthenticated?.() || !req.user) {
		return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
	}
	if (req.user.level !== -100) {
		return res.status(403).json({ code: 'FORBIDDEN', message: 'Admin access required' });
	}
	next();
}
