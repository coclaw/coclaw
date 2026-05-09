import 'dotenv/config';

import { startServer } from './server.js';

startServer().catch((err) => {
	console.error('[coclaw/server] failed to start:', err);
	process.exit(1);
});
