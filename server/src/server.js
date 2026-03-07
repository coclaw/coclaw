import { createApp } from './app.js';
import { attachBotWsHub } from './bot-ws-hub.js';

export function startServer() {
	const app = createApp();
	const port = Number(process.env.PORT ?? 3000);

	const server = app.listen(port, () => {
		console.log(`[coclaw/server] listening on :${port}`);
	});

	attachBotWsHub(server);

	return server;
}
