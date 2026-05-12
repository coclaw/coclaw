import { expect, test } from '@playwright/test';

import { TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';

/**
 * S3 集成验证 · 场景③：跨 login/logout 时 uiId 不变 / seq 单调 / server 端身份段切换
 *
 * 任务文档：docs/tasks/ui-remote-log-http-channel.md
 * 设计文档：docs/designs/ui-remote-log-http-channel.md §3.1 / §3.6 / §5.2
 *
 * 测试结构：
 *   - 同时监听 `request` 和 `response` 事件：
 *     - request 端：同步 push entry（保证 batches 数组次序 == 网络发起次序），
 *       异步 allHeaders 拿 cookie 后回填到同一 entry（避免事件 handler async 化
 *       导致 push 次序与 request 触发次序错位）
 *     - response 端：核对每个 batch POST 都得到 200 —— 否则即使 batch 出网，
 *       端点可能已经被改坏（404/500 等）而测试仍假阳性通过
 *   - 三阶段（anon → user → anon-again）各注入 5 条**带唯一前缀**的 log + flush，
 *     断言：
 *       ① 每阶段至少 1 batch
 *       ② 每阶段 batch 的 logs[] 至少含一条匹配 phase 前缀的注入文本
 *          —— 避免被自然出网的 sig./rtc. 等背景 log 单独"撑数"，
 *          那种情况下若我们注入的 log 全丢，测试仍会假阳性通过
 *       ③ 所有 batch 响应必须 200
 *       ④ uiId 全程一致；seq 严格单调
 *       ⑤ anon 阶段无 `coclaw.sid` cookie；user 阶段有
 *
 *   server 端身份段（`[user:<id>]` / `[anon]`）由 `req.isAuthenticated()` 决定，
 *   logout 会 destroy server-side session 但不会 clearCookie ——
 *   所以 anon2 阶段浏览器仍持有 cookie，server 解析后视为 anon。
 *   为可观测地证实"服务端身份段切换"，每阶段额外探针 `/api/v1/user`（共享同一 session
 *   middleware）：401 → server 视为 anon；200 → server 视为 user。
 */
test.describe('@auth remote-log cross login/logout', () => {
	test('uiId 跨 login/logout 不变 / seq 单调 / server 身份段随登录态切换', async ({ page }) => {
		test.setTimeout(60_000);

		/** @type {{ uiId: string|undefined, seq: number|undefined, sample: string, logTexts: string[], hasSid: boolean, cookieHeader: string, status: number, phase: string }[]} */
		const batches = [];
		/** request URL → entry 索引，便于 response handler 回填 status */
		const reqIndex = new WeakMap();

		// 同步 push entry，确保 batches 数组次序对应网络发起次序。
		// allHeaders 是 async，但 push 已发生；async 回填只更新 entry 字段。
		page.on('request', (req) => {
			if (req.method() !== 'POST') return;
			if (!req.url().endsWith('/api/v1/log/ui')) return;
			let body = null;
			try { body = JSON.parse(req.postData() || 'null'); }
			catch { /* ignore */ }
			if (!body) return;
			const logs = Array.isArray(body.logs) ? body.logs : [];
			const entry = {
				uiId: body.uiId,
				seq: body.seq,
				sample: logs[0]?.text?.slice(0, 120) ?? '',
				logTexts: logs.map((l) => String(l?.text ?? '')),
				hasSid: false,
				cookieHeader: '',
				status: 0,
				phase: 'pending',
			};
			batches.push(entry);
			reqIndex.set(req, entry);
			// 异步回填 Cookie（同步 req.headers() 在新版 Playwright 中过滤掉 Cookie）
			req.allHeaders().then((all) => {
				const c = all.cookie || all.Cookie || '';
				entry.cookieHeader = c.slice(0, 80);
				entry.hasSid = /(^|;\s*)coclaw\.sid=/.test(c);
			}).catch(() => { /* ignore */ });
			console.log(`[batch-captured] seq=${entry.seq} sample="${entry.sample}"`);
		});
		page.on('response', async (resp) => {
			const req = resp.request();
			const entry = reqIndex.get(req);
			if (!entry) return;
			entry.status = resp.status();
			console.log(`[batch-responded] seq=${entry.seq} status=${entry.status}`);
		});

		// ----- 阶段 1：anon（未登录） -----
		await page.goto('/login');
		await expect(page.getByTestId('login-page')).toBeVisible();
		const probeAnon = await page.request.get('/api/v1/user');
		expect(probeAnon.status(), 'phase-anon: server should treat as anon').toBe(401);

		const beforeAnon = batches.length;
		await page.evaluate(async () => {
			const mod = await import('/src/services/remote-log.js');
			for (let i = 0; i < 5; i++) mod.remoteLog(`e2e.anon.${i}`);
			mod.useRemoteLog().flush();
		});
		// 给 flush 触发的 POST 留出请求事件触发 + 响应抵达余量（本地链路通常 < 50ms）
		await page.waitForTimeout(1500);
		const anonEnd = batches.length;
		expect(anonEnd, 'anon phase: at least one batch should be POSTed').toBeGreaterThan(beforeAnon);
		for (let i = beforeAnon; i < anonEnd; i++) batches[i].phase = 'anon';

		// ----- 阶段 2：登录后 user -----
		await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
		await page.getByTestId('login-password').fill(TEST_PASSWORD);
		await page.getByTestId('btn-login').click();
		await expect(page).not.toHaveURL(/\/login$/, { timeout: 10_000 });
		await expect(page.getByTestId('session-user')).toBeVisible();

		const probeUser = await page.request.get('/api/v1/user');
		expect(probeUser.status(), 'phase-user: server should treat as authenticated').toBe(200);

		await page.evaluate(async () => {
			const mod = await import('/src/services/remote-log.js');
			for (let i = 0; i < 5; i++) mod.remoteLog(`e2e.user.${i}`);
			mod.useRemoteLog().flush();
		});
		await page.waitForTimeout(1500);
		const userEnd = batches.length;
		expect(userEnd, 'user phase: at least one new batch should be POSTed').toBeGreaterThan(anonEnd);
		for (let i = anonEnd; i < userEnd; i++) batches[i].phase = 'user';

		// ----- 阶段 3：登出后再次 anon -----
		await page.getByTestId('user-menu-trigger').click();
		await page.getByTestId('btn-logout').click();
		await expect(page).toHaveURL(/\/about$/, { timeout: 10_000 });

		const probeAnon2 = await page.request.get('/api/v1/user');
		expect(probeAnon2.status(), 'phase-anon2: server should treat as anon after logout (session destroyed)').toBe(401);

		await page.evaluate(async () => {
			const mod = await import('/src/services/remote-log.js');
			for (let i = 0; i < 5; i++) mod.remoteLog(`e2e.anon2.${i}`);
			mod.useRemoteLog().flush();
		});
		await page.waitForTimeout(1500);
		const anon2End = batches.length;
		expect(anon2End, 'anon2 phase: at least one new batch should be POSTed after logout').toBeGreaterThan(userEnd);
		for (let i = userEnd; i < anon2End; i++) batches[i].phase = 'anon2';

		console.log('captured remote-log batches:\n' + JSON.stringify(batches, null, 2));

		// ----- 断言 -----

		// 0) 所有 batch 响应必须 200（否则 endpoint 可能已坏掉，测试不应假阳性）
		for (const b of batches) {
			expect(b.status, `batch seq=${b.seq} should have responded 200, got ${b.status}`).toBe(200);
		}

		// 1) uiId 全程一致（设计 §3.1：跨登录态保持不变；唯一重置时机是 UI 实例重建）
		const uiIds = new Set(batches.map((b) => b.uiId).filter(Boolean));
		expect(uiIds.size, `uiId set across all batches: ${[...uiIds].join(',')}`).toBe(1);
		const [uiId] = uiIds;
		expect(uiId, 'uiId should be a 21-char nanoid').toMatch(/^[A-Za-z0-9_-]{21}$/);

		// 2) seq 严格单调递增（设计 §3.1：跨 login/logout 不重置）
		for (let i = 1; i < batches.length; i++) {
			expect(batches[i].seq, `seq at index ${i} should be > ${batches[i - 1].seq}`).toBeGreaterThan(batches[i - 1].seq);
		}

		// 3) 每阶段必须实际承载到注入的 log 文本（防"背景 sig.* batch 撑数 + 注入丢失"假阳性）
		const phasePrefix = { anon: 'e2e.anon.', user: 'e2e.user.', anon2: 'e2e.anon2.' };
		for (const phase of ['anon', 'user', 'anon2']) {
			const phaseBatches = batches.filter((b) => b.phase === phase);
			expect(phaseBatches.length, `${phase} phase must have at least one batch`).toBeGreaterThan(0);
			const carried = phaseBatches.some((b) => b.logTexts.some((t) => t.startsWith(phasePrefix[phase])));
			expect(carried, `${phase} phase must carry injected logs with prefix ${phasePrefix[phase]}`).toBeTruthy();
		}

		// 4) 客户端 cookie 状态：anon 无 cookie；user 有 cookie；
		//    anon2 不强断言 hasSid——logout 不 clearCookie 是 server 现状；
		//    server-side 视为 anon 由本阶段 probeAnon2(401) 证明。
		const anonBatches = batches.filter((b) => b.phase === 'anon');
		const userBatches = batches.filter((b) => b.phase === 'user');

		for (const b of anonBatches) {
			expect(b.hasSid, `anon batch seq=${b.seq} should not carry session cookie`).toBeFalsy();
		}
		for (const b of userBatches) {
			expect(b.hasSid, `user batch seq=${b.seq} should carry session cookie`).toBeTruthy();
		}
	});
});
