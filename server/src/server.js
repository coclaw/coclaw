import { createApp } from './app.js';
import { attachClawWsHub } from './claw-ws-hub.js';
import { attachRtcSignalHub } from './rtc-signal-hub.js';

export function startServer() {
	const app = createApp();
	const port = Number(process.env.PORT ?? 3000);

	const server = app.listen(port, () => {
		console.log(`[coclaw/server] listening on :${port}`);
	});

	attachClawWsHub(server, { sessionMiddleware: app.sessionMiddleware });
	attachRtcSignalHub(server, { sessionMiddleware: app.sessionMiddleware });

	return server;
}
