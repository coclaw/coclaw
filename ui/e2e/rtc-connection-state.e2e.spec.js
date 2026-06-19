import { test, expect } from '@playwright/test';
import { login, navigateToMainChat, waitChatReady, evalStore, typeText } from './helpers.js';
import { tr } from './model-config-mock.js';

/**
 * RTC 连接生命周期的 UI 覆盖（@rtc）
 *
 * 真实 RTC 极难稳定断开/重连（ICE restart 有 3min 恢复预算、DC alive 时 connReady watcher
 * 不翻），故本批不去真的弄断 RTC，而是**内存态注入连接状态**驱动 UI：
 *  - ChatPage 顶部连接横幅（connStatusText / connStatusSeverity）：直接 flip claws store
 *    的 byId[clawId] 字段（online / dcReady / rtcPhase / retryNextAt），断言横幅文案与
 *    severity（warn/info）。
 *  - MainList Capacitor 头部（rtc-connecting / rtc-unreachable）：addInitScript 伪造
 *    Capacitor android 平台让 isCapacitorApp=true + 移动视口，注入一个测试 claw 驱动
 *    isConnectingRtc / unreachableClaws 两个 getter，断言 spinner / warning 刷新按钮。
 *  - RPC 超时反馈：在 ClawConnection.request 边界把 agent run RPC 合成 RPC_TIMEOUT reject
 *    （等价于前端超时分支），断言发送操作有 toast 反馈且发送态恢复、不永久挂起。
 *
 * 安全：仅内存态注入 + RPC 边界 mock，绝不真的解绑/移除 claw、不动 bindings.json；注入的
 * 测试 claw（id 前缀 e2e-）无真实连接，manualRetry 走 __ensureRtc 早退（无 conn）。
 */

// ChatPage 连接横幅：静态 class 组合唯一锚定该 div（与分页/历史加载提示 text-xs 区分）
function connBanner(page) {
	return page.locator('[data-testid="chat-root"] .mx-4.mt-4.rounded-lg.px-4.py-2.text-center.text-sm');
}

/** 内存 flip 指定 claw 的运行时字段（直接改 byId，不走 action，无生命周期副作用） */
function patchClaw(page, clawId, patch) {
	return evalStore(page, 'claws', `
		const c = store.byId[${JSON.stringify(clawId)}];
		if (!c) return false;
		Object.assign(c, ${JSON.stringify(patch)});
		return true;
	`);
}

/**
 * 把指定 claw 隔离出 live RTC / SSE 生命周期，使注入的"建连中/失败"降级态在断言期间恒定。
 *
 * 背景：这两个用例断言的横幅要求 online=true + dcReady=false，但真实在线 claw 的 DC 全程开着，
 * store 会从多条路径把注入的 dcReady=false 抹回 true（实测 trace 确认）：
 *  - `onRtcStateChange('connected')`：RTC 传输事件经 conn.rtc.onStateChange 回调回写；
 *  - `__ensureRtc` 的 connected 早退 / rebuild 成功路径（L1085 直接写，无守卫）；
 *  - SSE：`applySnapshot` / `updateClawOnline` 见 online 仍 true 但 rtcPhase='failed'（warn 用例
 *    注入态）→ `__resumeOnline` rescue → `__ensureRtc` 重连；
 *  - 最隐蔽的一条：**页面加载期那次 __ensureRtc build 可能仍在 `await initRtc` 中飞**。它在冻结
 *    之后才收尾——DC open 时 `dc.onopen → rtc.onReady → conn.setRtc` 重挂 conn.__rtc，并经
 *    L1085 / onStateChange 写 dcReady=true，**完全绕过 store 方法 stub**（stub 只换方法引用，拦不
 *    住已在执行的那次调用）。这是反复偶发 flake 的真凶。
 *
 * 隔离手段（纯测试态、不改 src，fresh-page-per-test 无跨用例泄漏）：
 *  1) 先等 RTC 连续稳定一小段，确保有一条真连接、页面进入稳态再动手；
 *  2) stub `__ensureRtc` / `applySnapshot` / `updateClawOnline` → no-op：堵住此后一切**新发起**
 *     的 build 与 SSE rescue；
 *  3) stub `conn.setRtc` → no-op：DC open 时 rtc.onReady 重挂 conn.__rtc 的唯一通道，置空后任何
 *     rtc 实例（含 in-flight build 的）都挂不回来；
 *  4) `closeRtcForClaw(clawId)` 中止仍在飞的那次 build（每 claw 只允许一个 in-flight）：close 让
 *     其 initRtc settle 'failed'，等它的 __ensureRtc 拿到 'failed' 走失败分支、不再执行只在 'rtc'
 *     时跑的 L1085 写点；其 dc.onopen 也因已 settled 不再触发 onReady。这一步消除上面那条"绕过
 *     stub 的 in-flight 直写"；
 *  5) 切断当前 conn.rtc.onStateChange + 置空 conn.__rtc：兜底断开 onRtcStateChange 回写
 *     （守卫 conn.rtc?.isReady 恒 false）。
 * 合上后，注入的 dcReady/rtcPhase 不再被任何 live RTC / SSE 事件改写。
 */
async function freezeRtcWriters(page, clawId) {
	// 步骤 1：等 RTC 连续稳定（≥8 次 ×100ms = 800ms 都 ready），确保有真连接 + 页面稳态。
	await page.waitForFunction(async (cid) => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		const claw = pinia?._s?.get('claws')?.byId?.[cid];
		let ready = false;
		if (claw?.dcReady) {
			const m = await import('/src/services/claw-connection-manager.js');
			const rtc = m.useClawConnections().get(cid)?.rtc;
			ready = !!(rtc && rtc.isReady && rtc.state === 'connected');
		}
		window.__rtcReadyStreak = ready ? (window.__rtcReadyStreak || 0) + 1 : 0;
		return window.__rtcReadyStreak >= 8;
	}, clawId, { timeout: 25_000, polling: 100 });

	// 步骤 2~5：装上所有隔离闸。
	const CID = JSON.stringify(clawId);
	return evalStore(page, 'claws', `
		return (async () => {
			// 堵新 build / SSE rescue 的所有入口（后续没人再发起重连）。
			store.__ensureRtc = () => Promise.resolve();
			store.applySnapshot = () => {};
			store.updateClawOnline = () => {};
			const mgr = await import('/src/services/claw-connection-manager.js');
			const rtcMod = await import('/src/services/webrtc-connection.js');
			const conn = mgr.useClawConnections().get(${CID});
			if (conn) {
				// setRtc 是 DC open 时 rtc.onReady 重挂 conn.__rtc 的唯一通道（in-flight build 的
				// dc.onopen 会绕过 __ensureRtc 直接走这里）——置 no-op，任何实例都挂不回来。
				conn.setRtc = () => {};
				if (conn.rtc) conn.rtc.onStateChange = null;
			}
			// 中止仍在飞的那次 build（每 claw 只允许一个）：close 让其 initRtc settle 'failed'，
			// 等它的 __ensureRtc 拿到 'failed' 走失败分支、不写 dcReady（L1085 只在 'rtc' 时执行）；
			// 其 dc.onopen 也因已 settled 而不再触发 onReady→setRtc。这是消除 in-flight build 直接
			// 写 dcReady=true（绕过所有 stub）的关键一步。
			rtcMod.closeRtcForClaw(${CID});
			if (conn) conn.__rtc = null;
			return true;
		})();
	`);
}

// ----------------------------------------------------------------
// 连接状态横幅（ChatPage）：severity warn / info
// ----------------------------------------------------------------

test('连接建立/恢复中：ChatPage 横幅显示 info 级"建立连接中" @rtc @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁 = isLoadingChat=false），此时 DC 已就绪、scrollReady
	// 已置位（横幅所在 scrollContent 不再被 visibility:hidden 遮挡）。比 waitChatInputStable
	// 轻量，不依赖历史列表 RPC 落定，规避冷网关下其 30s 预算偶发耗尽的共享 helper flake。
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	// 先把该 claw 从 live RTC / SSE 生命周期里隔离出来（详见 freezeRtcWriters），否则真实 DC 的
	// RTC 传输事件 / SSE rescue 会把下面注入的 dcReady=false 抹回 true，致横幅闪失 / flake。
	await freezeRtcWriters(page, ctx.clawId);
	// 强制"建连中"：online 但 DC 未就绪 + rtcPhase=building
	const ok = await patchClaw(page, ctx.clawId, { online: true, dcReady: false, rtcPhase: 'building', retryNextAt: 0 });
	test.skip(!ok, 'claw not present in store');

	const b = connBanner(page);
	await expect(b).toBeVisible({ timeout: 10_000 });
	await expect(b).toContainText(await tr(page, 'chat.connBuilding'));
	// info severity：text-muted，且非 warn
	await expect(b).toHaveClass(/text-muted/);
	await expect(b).not.toHaveClass(/text-warning/);
});

test('重试耗尽不可达：ChatPage 横幅显示 warn 级"连接失败" @rtc @ui @resilience', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁 = isLoadingChat=false），此时 DC 已就绪、scrollReady
	// 已置位（横幅所在 scrollContent 不再被 visibility:hidden 遮挡）。比 waitChatInputStable
	// 轻量，不依赖历史列表 RPC 落定，规避冷网关下其 30s 预算偶发耗尽的共享 helper flake。
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	// 先把该 claw 从 live RTC / SSE 生命周期里隔离出来（同 info 用例，详见 freezeRtcWriters），
	// 保证下面注入的 dcReady=false 在断言期间不被真实 RTC 事件 / SSE rescue 抹回 true。
	await freezeRtcWriters(page, ctx.clawId);
	// 强制"退避耗尽不可达"：failed + retryNextAt=0
	const ok = await patchClaw(page, ctx.clawId, { online: true, dcReady: false, rtcPhase: 'failed', retryNextAt: 0 });
	test.skip(!ok, 'claw not present in store');

	const b = connBanner(page);
	await expect(b).toBeVisible({ timeout: 10_000 });
	await expect(b).toContainText(await tr(page, 'chat.connRetryExhausted'));
	// warn severity：text-warning
	await expect(b).toHaveClass(/text-warning/);
});

test('Claw 离线：ChatPage 横幅显示 warn 级"已离线" @rtc @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁 = isLoadingChat=false），此时 DC 已就绪、scrollReady
	// 已置位（横幅所在 scrollContent 不再被 visibility:hidden 遮挡）。比 waitChatInputStable
	// 轻量，不依赖历史列表 RPC 落定，规避冷网关下其 30s 预算偶发耗尽的共享 helper flake。
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	const ok = await patchClaw(page, ctx.clawId, { online: false });
	test.skip(!ok, 'claw not present in store');

	const b = connBanner(page);
	await expect(b).toBeVisible({ timeout: 10_000 });
	await expect(b).toContainText(await tr(page, 'chat.clawOffline'));
	await expect(b).toHaveClass(/text-warning/);
});

test('连接降级后恢复：warn 横幅出现，连接就绪后横幅消失 @rtc @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁 = isLoadingChat=false），此时 DC 已就绪、scrollReady
	// 已置位（横幅所在 scrollContent 不再被 visibility:hidden 遮挡）。
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	// 降级用 offline（online:false）而非 dcReady/rtcPhase 注入：真实 DC 仍开着，RTC 传输事件
	// 会在断言间隙把注入的 dcReady=false 抹回 true（claws.store 内 DC 状态回调写 dcReady=true），
	// 致横幅偶发消失（曾观测：toContainText 通过、toHaveClass 时元素已不在）。online 只由 SSE
	// claw.status 事件改写，测试窗口内真实 presence 不变 → 无事件回退，offline 横幅稳定（与既有
	// "Claw 离线"用例同路径，故同样稳）。
	const ok = await patchClaw(page, ctx.clawId, { online: false });
	test.skip(!ok, 'claw not present in store');

	const b = connBanner(page);
	await expect(b).toBeVisible({ timeout: 10_000 });
	await expect(b).toContainText(await tr(page, 'chat.clawOffline'));
	await expect(b).toHaveClass(/text-warning/);

	// 恢复：连接就绪（online + dcReady）→ connStatusText 归空 → 横幅整块从 DOM 移除（v-if）。
	// 这是 RECOVERY 边界：既有用例只验降级、从不验横幅清除。online/dcReady 都回到真实态（在线 + DC
	// 已开），即便真实事件/快照再触发也维持就绪，横幅不会回弹。
	const ok2 = await patchClaw(page, ctx.clawId, { online: true, dcReady: true, rtcPhase: 'idle', retryNextAt: 0 });
	test.skip(!ok2, 'claw not present in store');
	await expect(connBanner(page)).toHaveCount(0, { timeout: 10_000 });
});

// ----------------------------------------------------------------
// Capacitor 头部连接指示：rtc-connecting spinner / rtc-unreachable 重连按钮
// ----------------------------------------------------------------

/**
 * 伪造 Capacitor android 平台：CapacitorCustomPlatform 让 @capacitor/core 把平台判定为
 * android（优先于 androidBridge 探测），从而 platform.js 的 isCapacitorApp / env.store
 * 的 isNative 均为 true；预置 window.Capacitor 兜底 platform.js 先于 @capacitor/core 读取
 * 的情况。原生插件无实现，相关调用在 initCapacitorApp 各自 try/catch 内被吞，不阻塞挂载。
 */
function fakeCapacitorAndroid(page) {
	return page.addInitScript(() => {
		window.CapacitorCustomPlatform = { name: 'android', plugins: {} };
		if (!window.Capacitor) {
			window.Capacitor = {
				isNativePlatform: () => true,
				getPlatform: () => 'android',
				isPluginAvailable: () => false,
				Plugins: {},
			};
		}
	});
}

test('Capacitor 头部：建连显示刷新 spinner、退避耗尽显示 warning 重连按钮并可点击重连 @rtc @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await fakeCapacitorAndroid(page);
	// 移动视口让 env.store.screen.ltMd=true，cap header 才渲染
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	await page.goto('/topics');
	// cap header 渲染确认（添加按钮恒在）；不在则说明伪造平台未生效
	await expect(page.getByTestId('cap-header-add-trigger')).toBeVisible({ timeout: 15_000 });

	const CID = 'e2e-cap-rtc';
	// 注入测试 claw：online + building → 驱动 isConnectingRtc。
	// 先把 applySnapshot 置空：SSE 全量快照会整体替换 byId，否则会在断言间隙把注入的
	// 合成 claw 抹掉（已观测到的 flake 根因）。header 此刻已渲染，停掉后续快照无副作用。
	// byId 整体替换为仅含合成 claw：把真实 claw 逐出 getter 取值范围，避免某台真实 claw
	// 恰处 building/recovering 时抢占 isConnectingRtc，致 unreachable 断言被 spinner 互斥挤掉。
	await evalStore(page, 'claws', `
		store.applySnapshot = () => {};
		store.byId = { [${JSON.stringify(CID)}]: {
			id: ${JSON.stringify(CID)}, name: 'E2E Cap RTC', online: true,
			rtcPhase: 'building', retryNextAt: 0, dcReady: false, retryCount: 0,
			initialized: true, lastSeenAt: 0, createdAt: 0, updatedAt: 0,
			pluginInfo: null, rtcTransportInfo: null, rtcPeerTransportInfo: null,
			lastAliveAt: 0, disconnectedAt: 0,
		} };
		return store.isConnectingRtc;
	`);
	await expect(page.getByTestId('rtc-connecting')).toBeVisible({ timeout: 10_000 });
	// spinner 期间不显示 warning 重连按钮（模板 v-else-if 互斥）
	await expect(page.getByTestId('rtc-unreachable')).toHaveCount(0);

	// 切到退避耗尽：failed + retryNextAt=0 → unreachableClaws
	await evalStore(page, 'claws', `
		store.byId[${JSON.stringify(CID)}].rtcPhase = 'failed';
		store.byId[${JSON.stringify(CID)}].retryNextAt = 0;
		return store.unreachableClaws.map((c) => c.id);
	`);
	await expect(page.getByTestId('rtc-unreachable')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('rtc-connecting')).toHaveCount(0);

	// 装观测：包裹 manualRetryUnreachable 记录调用；stub __ensureRtc 为 no-op 防真触 RTC
	await evalStore(page, 'claws', `
		window.__capManualRetry = 0;
		store.__ensureRtc = () => Promise.resolve();
		const orig = store.manualRetryUnreachable.bind(store);
		store.manualRetryUnreachable = function () { window.__capManualRetry++; return orig(); };
		return true;
	`);

	// 点击 warning 刷新按钮 → 触发一次"发起重连"动作
	await page.getByTestId('rtc-unreachable').click();
	await expect.poll(() => page.evaluate(() => window.__capManualRetry || 0), { timeout: 5000 }).toBeGreaterThan(0);
});

// ----------------------------------------------------------------
// RPC 超时反馈：发送操作超时 → toast 反馈 + 发送态恢复，不永久挂起
// ----------------------------------------------------------------

/**
 * 在 ClawConnection.request 边界把指定 method 合成为 reject（带 code）。document_start
 * 急切包裹同一份 Vite 缓存模块，抢在首个 RPC 之前生效；未命中规则原样透传真实链路。
 */
function installRpcRejectMock(page, rules) {
	return page.addInitScript((rules) => {
		const wrap = (CC) => {
			if (!CC || CC.__e2eRtcWrapped) return;
			CC.__e2eRtcWrapped = true;
			const orig = CC.prototype.request;
			CC.prototype.request = function (method, params = {}, options = {}) {
				for (const r of rules) {
					if (r.method === method) {
						const err = new Error(r.message || 'mock reject');
						err.code = r.code || 'MOCK_ERR';
						return Promise.reject(err);
					}
				}
				return orig.call(this, method, params, options);
			};
		};
		window.__rtcWrap = wrap;
		let tries = 0;
		const tryInstall = () => {
			import('/src/services/claw-connection.js')
				.then((m) => {
					if (m && m.ClawConnection) wrap(m.ClawConnection);
					else if (tries++ < 100) setTimeout(tryInstall, 20);
				})
				.catch(() => { if (tries++ < 100) setTimeout(tryInstall, 20); });
		};
		tryInstall();
	}, rules);
}

async function ensureRtcMock(page) {
	await page.evaluate(async () => {
		if (typeof window.__rtcWrap === 'function') {
			const m = await import('/src/services/claw-connection.js');
			if (m && m.ClawConnection) window.__rtcWrap(m.ClawConnection);
		}
	});
}

test('发送消息 RPC 超时：toast 反馈且发送态恢复（不永久挂起） @rtc @resilience', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// agent run 首阶段 RPC 合成 RPC_TIMEOUT reject（pre-acceptance）：
	// runAgent 抛 → sendMessage 抛 → ChatPage catch → notify.error(chat.errRpcTimeout)
	await installRpcRejectMock(page, [
		{ method: 'agent', code: 'RPC_TIMEOUT', message: 'rpc timeout' },
	]);

	await login(page);
	await ensureRtcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁 = isLoadingChat=false），此时 DC 已就绪、scrollReady
	// 已置位（横幅所在 scrollContent 不再被 visibility:hidden 遮挡）。比 waitChatInputStable
	// 轻量，不依赖历史列表 RPC 落定，规避冷网关下其 30s 预算偶发耗尽的共享 helper flake。
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	const msg = `rtc timeout e2e ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msg);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 反馈：超时 toast 出现（locale 无关）。exact 避开 aria-live 朗读区（其文本为 "Notification […]"）
	await expect(page.getByText(await tr(page, 'chat.errRpcTimeout'), { exact: true })).toBeVisible({ timeout: 10_000 });
	// 不永久挂起：发送态结束（btn-stop 不再显示）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 10_000 });
	// 输入未丢失：失败后草稿被回填
	await expect(page.getByTestId('chat-textarea')).toHaveValue(msg, { timeout: 8000 });
});
