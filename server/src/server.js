import { createApp } from './app.js';
import { attachClawWsHub } from './claw-ws-hub.js';
import { attachRtcSignalHub } from './rtc-signal-hub.js';
import { syncPresets as syncWebAgentPresets } from './repos/web-agent.repo.js';
import { startPolling as startPluginLatestPolling } from './services/plugin-latest.svc.js';

export async function startServer() {
	const app = createApp();
	const port = Number(process.env.PORT ?? 3000);

	// 必须在 app.listen 之前 await：避免早请求拿到旧/缺失数据
	await syncWebAgentPresets();

	const server = app.listen(port, () => {
		console.log(`[coclaw/server] listening on :${port}`);
	});

	attachClawWsHub(server, { sessionMiddleware: app.sessionMiddleware });
	attachRtcSignalHub(server, { sessionMiddleware: app.sessionMiddleware });
	startPluginLatestPolling();

	return server;
}
