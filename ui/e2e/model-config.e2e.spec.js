import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText } from './helpers.js';
import {
	MOCK_CATALOG,
	GROQ_PRIMARY,
	GROQ_PRIMARY_ALT,
	mockProfile,
	mockOauthProfile,
	setupModelConfigMock,
	ensureMockReady,
	getOnlineClawId,
	waitDashboardSettled,
	tr,
} from './model-config-mock.js';

/**
 * 模型配置（model-config）E2E —— 设计 § 11 的 4 条必测场景。
 *
 * 数据保真度：model-config 的 RPC（providerAuth.list/setApiKey/remove/catalog/loginOauth/cancelOauth、
 * model.list/set/listAvailable）+ `status` 在 RPC 边界（ClawConnection.request）被 mock 成有状态合成
 * 响应（详见 model-config-mock.js）；真实 claw 的连接 / 在线态 / dcReady / agents / sessions 仍走真实
 * WebRTC 链路。mock 不触碰 plugin 的 auth-profiles.json，跑完无任何真实 claw 残留。
 *
 * `status` 为何也合成：真实 status RPC 受 OpenClaw manifest-cache mismatch 影响每次卡 ~10s，会把
 * dashboard 的 loadDashboard 拖在飞行、触发 force-dedup 返回陈旧快照。合成 status 的 model/provider
 * 取自当前 mock primary。
 *
 * 非自指外层断言：本套件验证的"外层一致性"= 橙条引导 + dashboard store 派生字段（§7.4 后仪表盘
 * 凭据/有效性判定只吃 coclaw.model.list 出参的凭据信号，不再依赖 providerAuth.list 与 catalog）。
 * 注：/claws 已不再拉全量目录（§7.4）→ AgentCard 模型名徽章不再渲染，故本套件不再断言 modelLabel；
 * `status` 仍合成（供 instance.model/provider，且规避真实 status RPC 受 manifest-cache 卡 ~10s）。
 *
 * 标签：均属"导航/设置/交互"，按 e2e-test skill 标签表归 @ui。
 */

// 文案断言一律用 tr()（取应用当前语言下 i18n key 的渲染值），与具体语言解耦——
// 不依赖浏览器语言或 DB 用户持久化的 lang（登录会覆盖浏览器语言）。
const DESKTOP = { width: 1280, height: 720 };
// 桌面端子页 header 的返回按钮（MobilePageHeader 在桌面端 md:hidden，唯一可见 header 是 md:flex 那个）
const DESKTOP_BACK = 'header.md\\:flex';

/** 等待目标 claw 的 dashboard 拉取完成（AgentCard 渲染即代表连接 + dashboard 就绪） */
async function waitDashReady(page, clawId) {
	await expect(page.getByTestId(`claw-${clawId}`)).toBeVisible({ timeout: 30_000 });
	await expect(page.locator(`[data-testid="claw-${clawId}"] [data-testid^="agent-card-"]`).first())
		.toBeVisible({ timeout: 30_000 });
}

/**
 * 整页冷加载 /claws（仅用于首次建立连接）。重复整页 goto 会反复重建 WebRTC，
 * 拖慢且易抖；"写完返回外层"用 spaGo() 走应用内导航保持连接存活。
 */
async function gotoClawsCold(page) {
	await page.goto('/claws');
	await ensureMockReady(page);
}

/** 应用内（SPA）导航——不整页刷新，保持 WebRTC 连接存活，dashboard 重拉即时完成 */
async function spaGo(page, path) {
	await page.evaluate((p) => {
		const r = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
		if (!r) throw new Error('router not found');
		return r.push(p);
	}, path);
}

/**
 * 让指定 RPC method 直接 reject（用于验证子页"加载失败"分支）。
 *
 * 在 setupModelConfigMock 的 wrap 外再套一层：轮询等 mock 的 ClawConnection.__mcWrapped 就绪后，
 * 把 prototype.request 包成最外层——命中 failMethods 直接 reject（带 code），否则透传给内层 mock。
 * 必须在 setupModelConfigMock 之后调用；与 mock 同走 addInitScript，对该 page 后续每次页面加载生效。
 * @param {import('@playwright/test').Page} page
 * @param {string[]} failMethods
 */
function installRpcFailMock(page, failMethods) {
	return page.addInitScript((methods) => {
		const apply = (CC) => {
			// 只有等 mock 先包好（__mcWrapped）才套外层，确保 reject 拦在 mock 合成响应之前
			if (!CC || !CC.__mcWrapped || CC.__mcFailWrapped) return false;
			CC.__mcFailWrapped = true;
			const inner = CC.prototype.request;
			CC.prototype.request = function (method, params = {}, options = {}) {
				if (methods.indexOf(method) !== -1) {
					return Promise.reject(Object.assign(new Error('mock rpc failure'), { code: 'MOCK_FAIL' }));
				}
				return inner.call(this, method, params, options);
			};
			return true;
		};
		window.__mcFailApply = apply;
		let tries = 0;
		const tryInstall = () => {
			import('/src/services/claw-connection.js')
				.then((m) => { if (!apply(m && m.ClawConnection) && tries++ < 300) setTimeout(tryInstall, 10); })
				.catch(() => { if (tries++ < 300) setTimeout(tryInstall, 10); });
		};
		tryInstall();
	}, failMethods);
}

/** 兜底：导航后再确保一次 fail wrap 已生效（幂等，配合 installRpcFailMock 用） */
async function ensureFailReady(page) {
	await page.evaluate(async () => {
		if (typeof window.__mcFailApply === 'function') {
			const m = await import('/src/services/claw-connection.js');
			window.__mcFailApply(m && m.ClawConnection);
		}
	});
}

// ================================================================
// S1：首次接入主路径
// ================================================================
test('模型配置 S1：首次接入——橙条引导→配 key→选主模型→橙条消失 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 起始：零 provider、无主模型 → ManageClaws 应显示"未配 API key"橙条
	await setupModelConfigMock(page, { profiles: [], primary: null, catalog: MOCK_CATALOG });
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);

	// 橙条：未配 API key
	const bar = page.getByTestId(`guidance-${clawId}`);
	await expect(bar).toBeVisible({ timeout: 30_000 });
	await expect(bar).toContainText(await tr(page, 'modelConfig.guidance.noKeyWarning'));

	// 点模型行进子页（入口已上移到模型行；橙条不再带"去配置"链接）。noKey 态下模型行渲染 CTA，整行仍可点
	await page.getByTestId(`claw-model-${clawId}`).click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// 配第一个 API key：选 groq → 输入 key → 提交
	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('add-provider-item-groq').click();
	const keyInput = page.getByTestId('add-provider-key-input');
	// typeText 带读回校验+补齐，免疫高负载下逐字输入掉尾字符（key 框为空、单行、无换行，安全）
	await typeText(keyInput, 'sk-test-0000111122223333');
	await page.getByTestId('add-provider-submit').click();
	await expect(page.getByTestId('add-provider-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 凭据行出现（按行 testid 锚定裸 id；列表 label 现展示品牌名"Groq"，不能再按裸 id 文案断言）
	await expect(page.getByTestId('provider-auth-row-groq')).toBeVisible({ timeout: 10_000 });

	// 等 add 触发的外层 dashboard 重拉落定后再 pick：否则 add(primary=null) 的飞行刷新
	// 会被 pick 的 loadDashboard(force) 去重命中，外层卡在陈旧的"未配主模型"
	await waitDashboardSettled(page, clawId, { hasAny: true });

	// 还没主模型 → 选主模型
	const selBtn = page.getByTestId('btn-primary');
	await expect(selBtn).toBeVisible({ timeout: 10_000 });
	await selBtn.click();
	await expect(page.getByTestId('primary-picker-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId(`primary-picker-item-groq__${GROQ_PRIMARY.split('/')[1]}`).click();
	await expect(page.getByTestId('primary-picker-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 子页主模型区即时反映（primary-current 只显示 model 部分，不含 provider 前缀）
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY.split('/')[1]);

	// 仍在子页时先断言 store 已被写回调（onPrimaryPicked）的 loadDashboard(force) 刷成"有效主模型"——
	// 这把"写回调强刷新路径"本身锁住；否则后面 /claws 挂载时的 loadData 会把断言救活、掩盖回调回归
	await waitDashboardSettled(page, clawId, { hasAny: true, primaryModel: GROQ_PRIMARY, primaryEffective: true });

	// 返回 ManageClaws（SPA，连接存活）：外层 UI 一致性追上
	await spaGo(page, '/claws');
	await waitDashReady(page, clawId);
	// 橙条消失（橙条只吃 model.list 凭据信号，与 catalog/status 解耦 → 非自指断言）
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });
	// 注：/claws 不再拉全量目录（§7.4），AgentCard 模型名徽章已不显示——故此处不再断言 modelLabel
});

// ================================================================
// S2：撤销 primary 对应的 provider（强提示 + 撤后自动切失效）
// ================================================================
test('模型配置 S2：撤销主模型载体 provider——强提示分支→确认→橙条切"主模型失效" @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 起始：groq（承载 primary）+ anthropic（另一凭据，撤 groq 后仍非空），primary=groq/...
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq'), mockProfile('anthropic')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);
	// 起始 primary 有效 → 无橙条
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });

	// 点模型行进子页
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// 子页：主模型有效、两个凭据行
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY.split('/')[1], { timeout: 30_000 });
	// profiles[0] = groq（mock 固定顺序，ModelConfigPage 不排序）；即便选错行，下方"强提示分支"
	// 断言（confirmButtonStrong + descAffectPrimary 含 Groq/primary）也会失败，故选错行不会漏过
	const firstRemove = page.getByTestId('btn-remove-provider').first();
	await expect(firstRemove).toBeEnabled({ timeout: 30_000 });
	await firstRemove.click();

	// 强提示分支：确认按钮文案 = "Remove anyway"，正文含品牌名 + 当前 primary 串
	const confirm = page.getByTestId('btn-remove-confirm');
	await expect(confirm).toBeVisible({ timeout: 10_000 });
	// 强提示分支：确认按钮是"仍然撤销"变体 + 正文出现强提示文案（含当前 primary 串）
	await expect(confirm).toHaveText(await tr(page, 'modelConfig.providerAuth.remove.confirmButtonStrong'));
	// 正文用 testid 锚定，断言 locale 无关的两个不翻译标识：品牌名"Groq"（getProviderName）+ 完整 primary 串。
	// 不再按 descAffectPrimary 整段 i18n 文案断言（其 {provider} 现插值成品牌名，且文案随语言变）。
	const desc = page.getByTestId('remove-provider-desc');
	await expect(desc).toContainText('Groq');
	await expect(desc).toContainText(GROQ_PRIMARY);
	await confirm.click();
	await expect(page.getByTestId('btn-remove-confirm')).not.toBeVisible({ timeout: 15_000 });

	// 子页：groq 凭据行消失、anthropic 保留、主模型区切"失效"
	// 注意：撤掉载体后 primary 仍为 groq/...（失效态），主模型区 primary-current-provider 仍显示裸 "groq"（Tier-2 维持裸 id）。
	// 故按凭据行 testid 锚定（裸 id），避免被主模型区误命中、也不受展示 label 换名影响。
	await expect(page.getByTestId('provider-auth-row-groq')).toHaveCount(0, { timeout: 15_000 });
	await expect(page.getByTestId('provider-auth-row-anthropic')).toBeVisible();
	await expect(page.getByTestId('primary-warning')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('primary-warning')).toContainText(await tr(page, 'modelConfig.primary.invalidWarning'));

	// 返回 ManageClaws（SPA）：橙条自动切到"主模型失效"
	await spaGo(page, '/claws');
	await waitDashReady(page, clawId);
	const bar = page.getByTestId(`guidance-${clawId}`);
	await expect(bar).toBeVisible({ timeout: 30_000 });
	await expect(bar).toContainText(await tr(page, 'modelConfig.guidance.invalidPrimaryWarning'));
});

// ================================================================
// S3：切换主模型（选完即存、无二次确认、外层即时反映）
// ================================================================
test('模型配置 S3：切换主模型——无二次确认→toast→子页即时更新 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });

	// 点模型行进子页
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY.split('/')[1], { timeout: 30_000 });

	// 换模型：点"更换"→ picker → 点另一个模型
	const changeBtn = page.getByTestId('btn-primary');
	await expect(changeBtn).toBeEnabled({ timeout: 30_000 });
	await changeBtn.click();
	await expect(page.getByTestId('primary-picker-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId(`primary-picker-item-groq__${GROQ_PRIMARY_ALT.split('/')[1]}`).click();
	// 无二次确认：点击后 picker 直接关闭
	await expect(page.getByTestId('primary-picker-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 负向断言：picker 关闭后不存在任何对话框（含二次确认 modal）——锁死"选完即存、无二次确认"
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// 成功不弹 toast：主模型区即时刷新成新模型即是反馈（用户可直接分辨）
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY_ALT.split('/')[1]);

	// 仍在子页时断言 store 已被写回调（onPrimaryPicked）的 loadDashboard(force) 刷成新主模型——
	// 锁住写回调的强刷新路径（不依赖随后 /claws 挂载的 loadData 救活断言）
	await waitDashboardSettled(page, clawId, { primaryModel: GROQ_PRIMARY_ALT, primaryEffective: true });

	// 外层（SPA 返回，连接存活）：主模型仍有效 → 橙条保持不出现（非自指：只吃 model.list 凭据信号）
	await spaGo(page, '/claws');
	await waitDashReady(page, clawId);
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });
	// 注：/claws 不再拉全量目录（§7.4），AgentCard 模型名徽章已不显示——故此处不再断言 modelLabel
});

// ================================================================
// S4：桌面端返回行为（back() vs fallback）
// ================================================================
test('模型配置 S4a：桌面返回——从来路页进子页→back() 回到来路页（区别于 fallback）@ui', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize(DESKTOP);
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	// 优先 chat 作"来路页"（§11 原意）；无 chat session 时退用 /topics（navigateToChat 失败前已 goto 到此）。
	// 关键不变量：来路页 ≠ /claws —— 否则 back() 与 fallback('/claws') 终点相同，断言无法区分二者。
	const session = await navigateToChat(page);
	let clawId;
	if (session) {
		await waitChatReady(page);
		clawId = session.clawId;
	}
	else {
		clawId = await getOnlineClawId(page);
	}
	const priorUrl = page.url();
	expect(priorUrl, 'prior page must differ from /claws to distinguish back() vs fallback')
		.not.toMatch(/\/claws(?:\/)?$/);

	// 应用内 push 进子页（history.state.back 指向来路页）
	await spaGo(page, `/claws/${clawId}/models`);
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await ensureMockReady(page);

	// 桌面返回按钮 → history.state.back 存在 → router.back() → 回到来路页（而非 fallback /claws）
	const back = page.locator(DESKTOP_BACK).getByRole('button').first();
	await expect(back).toBeVisible({ timeout: 15_000 });
	await back.click();
	await expect(page).toHaveURL(priorUrl, { timeout: 15_000 });
});

test('模型配置 S4b：桌面返回——冷启 deep link（全新页签·无历史）→back 走 fallback /claws @ui', async ({ page, context }) => {
	test.setTimeout(90_000);
	await page.setViewportSize(DESKTOP);
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	// 先在当前页拿到一台在线 claw id
	await page.goto('/claws');
	await ensureMockReady(page);
	const clawId = await getOnlineClawId(page);

	// 真·冷启 deep link：开一个全新页签（无任何 SPA 历史），直接进子页（共享 context 的登录 cookie）。
	// 这样若 navBack 错误地走 router.back()，空历史下会"留在原地"（≠ /claws），才能抓到回归；
	// 正确实现 history.state.back 为空 → replace('/claws')。
	const deep = await context.newPage();
	await deep.setViewportSize(DESKTOP);
	await setupModelConfigMock(deep, {
		profiles: [mockProfile('groq')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	try {
		await deep.goto(`/claws/${clawId}/models`);
		await ensureMockReady(deep);

		const back = deep.locator(DESKTOP_BACK).getByRole('button').first();
		await expect(back).toBeVisible({ timeout: 15_000 });
		await back.click();
		await expect(deep).toHaveURL(/\/claws(?:\/)?$/, { timeout: 15_000 });
	}
	finally {
		await deep.close();
	}
});

// ================================================================
// S5：旧插件不再特判压制（feature-detect-suppress 已移除，§7.4）
// ================================================================
test('模型配置 S5：旧插件（出参无凭据信号）→ 据"无凭据"显示 noKey 橙条（不再压制）@ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 旧插件场景：legacy=true → coclaw.model.list 出参不带凭据信号字段。
	// feature-detect-suppress 已移除：旧插件给不出信号 → store 落 hasUsableCredential=false →
	// 该弹 noKey 就弹（升级窗口极窄，对小白主动引导是产品价值，宁可短暂提示也不沉默）。
	await setupModelConfigMock(page, { profiles: [], primary: GROQ_PRIMARY, catalog: MOCK_CATALOG, legacy: true });
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);
	// dashboard 拉取完成（loading=false）后再断言橙条，避免抢在加载中误判
	await waitDashboardSettled(page, clawId, { hasAny: false, primaryModel: GROQ_PRIMARY });

	// 不再压制：旧插件 + 无凭据 → 显示 noKey 引导橙条
	const bar = page.getByTestId(`guidance-${clawId}`);
	await expect(bar).toBeVisible({ timeout: 30_000 });
	await expect(bar).toContainText(await tr(page, 'modelConfig.guidance.noKeyWarning'));
});

// ================================================================
// S6：三源凭据——内联 key 可列可撤（强提示）+ env 行只读（§2.4 / §2.5）
// ================================================================
test('模型配置 S6：内联 key 列出可撤（强提示）、env 行只读禁删 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 起始：无账本；内联 groq（承载 primary）+ env anthropic（只读）。模拟"列表空但模型能用"的真实场景。
	await setupModelConfigMock(page, {
		profiles: [],
		inlineProviders: ['groq'],
		envProviders: ['anthropic'],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);
	// 内联 key 让主模型有效（凭据信号跨三源）→ 无橙条（核心：列表空也不误报）
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });

	// 点模型行进子页
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY.split('/')[1], { timeout: 30_000 });

	// 两条来源标签都在；env 行带"去主机移除"提示
	await expect(page.getByText(await tr(page, 'modelConfig.providerAuth.source.inline'), { exact: true })).toBeVisible();
	await expect(page.getByText(await tr(page, 'modelConfig.providerAuth.source.env'), { exact: true })).toBeVisible();
	await expect(page.getByText(await tr(page, 'modelConfig.providerAuth.envReadonlyHint'))).toBeVisible();

	// 两个撤销按钮：内联 groq 可点、env anthropic 禁用（列表顺序：内联在前、env 在后）
	const removeButtons = page.getByTestId('btn-remove-provider');
	await expect(removeButtons).toHaveCount(2);
	await expect(removeButtons.nth(0)).toBeEnabled();
	await expect(removeButtons.nth(1)).toBeDisabled();

	// 撤内联 groq（承载 primary）：强提示（撤内联不再单独提示"会改配置文件"——2026-05-28 拍板）
	await removeButtons.nth(0).click();
	const confirm = page.getByTestId('btn-remove-confirm');
	await expect(confirm).toBeVisible({ timeout: 10_000 });
	await expect(confirm).toHaveText(await tr(page, 'modelConfig.providerAuth.remove.confirmButtonStrong'));
	await confirm.click();
	await expect(page.getByTestId('btn-remove-confirm')).not.toBeVisible({ timeout: 15_000 });

	// 内联 groq 凭据行消失、主模型切失效；env anthropic 行仍在（不可撤）
	// 同 S2：失效 primary 仍在主模型区显示裸 "groq"（Tier-2 维持裸 id），故按凭据行 testid（裸 id）锚定。
	await expect(page.getByTestId('provider-auth-row-groq')).toHaveCount(0, { timeout: 15_000 });
	await expect(page.getByTestId('primary-warning')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('primary-warning')).toContainText(await tr(page, 'modelConfig.primary.invalidWarning'));
	await expect(page.getByTestId('provider-auth-row-anthropic')).toBeVisible();
});

// ================================================================
// S7：选模型器吃 listAvailable 的 byProvider——能选到别名套餐变体（决策4）
// ================================================================
test('模型配置 S7：选模型器来自 listAvailable，能选中别名套餐变体模型 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 持基座 volcengine key；catalog 含基座 doubao-pro + 变体 ark-code-latest（manifest 变体一等公民）。
	// listAvailable mock：基座 key 同时点亮 volcengine + volcengine-plan → byProvider 两者都出。
	const VARIANT_CATALOG = [
		{ id: 'doubao-pro', provider: 'volcengine', name: 'Doubao Pro' },
		{ id: 'ark-code-latest', provider: 'volcengine-plan', name: 'Ark Code' },
	];
	await setupModelConfigMock(page, {
		profiles: [mockProfile('volcengine')],
		primary: 'volcengine/doubao-pro',
		catalog: VARIANT_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);
	// 基座 key 让主模型有效 → 无橙条
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });

	// 点模型行进子页，主模型有效
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await expect(page.getByTestId('primary-current')).toHaveText('doubao-pro', { timeout: 30_000 });

	// 打开选模型器（来自 listAvailable byProvider）：变体作为一等可选项出现
	const changeBtn = page.getByTestId('btn-primary');
	await expect(changeBtn).toBeEnabled({ timeout: 30_000 });
	await changeBtn.click();
	await expect(page.getByTestId('primary-picker-dialog')).toBeVisible({ timeout: 10_000 });
	const variantItem = page.getByTestId('primary-picker-item-volcengine-plan__ark-code-latest');
	await expect(variantItem).toBeVisible({ timeout: 10_000 });
	// 选中别名套餐变体 → 即选即存
	await variantItem.click();
	await expect(page.getByTestId('primary-picker-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 子页主模型区即时反映为变体（凭据信号别名感知 → 仍有效，不误报失效）
	await expect(page.getByTestId('primary-current')).toHaveText('ark-code-latest');
});

// ================================================================
// S8：加 provider——账号授权步展示授权链接 + 授权码（两阶段 phase-1 展示流）
// ================================================================
test('模型配置 S8：加 provider 账号授权入口——展示授权链接 + 码，可取消返回 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// groq 已配（hasCred → 排除）；github-copilot 仅账号授权、未配 → 出现在加 provider 列表且单方式直达账号授权步
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
		catalogProviders: [
			{ provider: 'groq', authMethods: ['api-key'] },
			{ provider: 'github-copilot', authMethods: ['oauth-device-code'] },
		],
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);

	// 点模型行进子页
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// 打开加 provider → 选 github-copilot（单一账号授权方式 → 直达账号授权步，无 chooser）
	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });
	// groq 已配 → 不在加列表；github-copilot 未配 → 在
	await expect(page.getByTestId('add-provider-item-groq')).toHaveCount(0);
	await page.getByTestId('add-provider-item-github-copilot').click();

	// 账号授权步：phase-1 受理帧（mock 异步推）→ 展示授权链接 + 授权码
	await expect(page.getByTestId('oauth-login-step')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('oauth-verification-link')).toContainText('github.com/login/device', { timeout: 10_000 });
	await expect(page.getByTestId('oauth-user-code')).toHaveText('E2E-CODE');

	// 取消（调 cancelOauth）→ 返回 provider 选择列表（单方式 provider 的取消回退）
	await page.getByTestId('oauth-cancel').click();
	await expect(page.getByTestId('add-provider-list')).toBeVisible({ timeout: 10_000 });
});

// ================================================================
// S9：oauth 凭据行显示 oauth 徽章（撤销纯看 removable，不再有白名单门）
// ================================================================
test('模型配置 S9：oauth 凭据显示 oauth 徽章且可撤销 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// minimax-portal 走 oauth 凭据（type='oauth'）+ groq api_key 承载 primary（避免 notSet 噪音）
	await setupModelConfigMock(page, {
		profiles: [mockProfile('groq'), mockOauthProfile('minimax-portal')],
		primary: GROQ_PRIMARY,
		catalog: MOCK_CATALOG,
	});
	await login(page);
	await ensureMockReady(page);

	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await waitDashReady(page, clawId);

	// 点模型行进子页
	const modelRow = page.getByTestId(`claw-model-${clawId}`);
	await expect(modelRow).toBeVisible({ timeout: 30_000 });
	await modelRow.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// oauth 行带 oauth 徽章（字面量 oauth，不进 i18n）
	const oauthTag = page.getByTestId('provider-oauth-tag');
	await expect(oauthTag).toBeVisible({ timeout: 30_000 });
	await expect(oauthTag).toHaveText('oauth');
	// 撤销按钮：removable=true → 两行各一个、均可点（oauth 撤销纯看 removable）
	const removeButtons = page.getByTestId('btn-remove-provider');
	await expect(removeButtons).toHaveCount(2);
	await expect(removeButtons.nth(0)).toBeEnabled();
	await expect(removeButtons.nth(1)).toBeEnabled();
});

// ================================================================
// 公共：进入某台在线 claw 的模型配置子页（仅建连取 id，再 SPA 进子页，保持连接存活）
// ================================================================
async function enterModelConfigPage(page) {
	await gotoClawsCold(page);
	const clawId = await getOnlineClawId(page);
	await spaGo(page, `/claws/${clawId}/models`);
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await ensureMockReady(page);
	return clawId;
}

// ================================================================
// C5a：加 provider 弹窗——可加目录为空 → 空态渲染
// ================================================================
test('模型配置 C5a：加 provider 弹窗——可加目录为空时渲染空态 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 空目录（catalog=[] → providerAuth.catalog 返回 providers:[]）→ 弹窗无可加项
	await setupModelConfigMock(page, { profiles: [], primary: null, catalog: [] });
	await login(page);
	await ensureMockReady(page);

	await enterModelConfigPage(page);

	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });

	// 空态占位渲染、且无任何 provider 项
	const empty = page.getByTestId('add-provider-empty');
	await expect(empty).toBeVisible({ timeout: 10_000 });
	await expect(empty).toHaveText(await tr(page, 'modelConfig.providerAuth.add.noProviders'));
	await expect(page.locator('[data-testid^="add-provider-item-"]')).toHaveCount(0);
});

// ================================================================
// C5b：模型配置子页——三核心 RPC（含 catalog）全失败 → "加载失败"重试入口
// ================================================================
test('模型配置 C5b：catalog 等核心 RPC 失败 → 渲染加载失败重试入口 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// 三核心 RPC（providerAuth.list / model.list / providerAuth.catalog）全 reject → fullyFailed
	// → 子页顶部出 load-failed 重试条（catalog 加载失败的真实外显面；弹窗本身无独立 catalog-error 态）。
	await setupModelConfigMock(page, { profiles: [], primary: null, catalog: MOCK_CATALOG });
	await installRpcFailMock(page, [
		'coclaw.providerAuth.list',
		'coclaw.model.list',
		'coclaw.providerAuth.catalog',
	]);
	await login(page);
	await ensureMockReady(page);
	await ensureFailReady(page);

	await enterModelConfigPage(page);
	await ensureFailReady(page);

	// 三核心 RPC 全失败 → load-failed 重试条出现（含文案 + 重试按钮）
	const failBar = page.getByTestId('load-failed');
	await expect(failBar).toBeVisible({ timeout: 30_000 });
	await expect(failBar).toContainText(await tr(page, 'modelConfig.providerAuth.loadFailed'));
	await expect(failBar.getByRole('button')).toBeVisible();
});

// ================================================================
// C6：加 provider 弹窗——搜索框过滤收窄列表
// ================================================================
test('模型配置 C6：加 provider 弹窗——搜索过滤收窄列表 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// groq + anthropic 均未配 → 都在可加列表
	await setupModelConfigMock(page, {
		profiles: [],
		primary: null,
		catalog: MOCK_CATALOG,
		catalogProviders: [
			{ provider: 'groq', authMethods: ['api-key'] },
			{ provider: 'anthropic', authMethods: ['api-key'] },
		],
	});
	await login(page);
	await ensureMockReady(page);

	await enterModelConfigPage(page);

	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });

	// 过滤前：两个 provider 都在
	await expect(page.getByTestId('add-provider-item-groq')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('add-provider-item-anthropic')).toBeVisible();

	// 搜 "anthropic"：只剩 anthropic，groq 被收窄掉
	await page.getByTestId('add-provider-search').fill('anthropic');
	await expect(page.getByTestId('add-provider-item-anthropic')).toBeVisible();
	await expect(page.getByTestId('add-provider-item-groq')).toHaveCount(0);

	// 搜不匹配关键词：列表清空 → 空态
	await page.getByTestId('add-provider-search').fill('zzz-no-match');
	await expect(page.getByTestId('add-provider-empty')).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('[data-testid^="add-provider-item-"]')).toHaveCount(0);
});

// ================================================================
// C7：加 provider 弹窗——oauth-login（浏览器登录）入口在方式选择器中呈现并可返回
// ================================================================
test('模型配置 C7：加 provider 弹窗——oauth-login 入口呈现于方式选择器、可返回 @ui', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	// gemini 同时支持 api-key + oauth-login（无 device-code）→ 方式选择器列两项。
	// oauth-login 是浏览器回环登录入口（区别于 S8 的设备码流），当前为"暂不支持"：点击不进子屏、停留选择器。
	await setupModelConfigMock(page, {
		profiles: [],
		primary: null,
		catalog: MOCK_CATALOG,
		catalogProviders: [
			{ provider: 'gemini', authMethods: ['api-key', 'oauth-login'] },
		],
	});
	await login(page);
	await ensureMockReady(page);

	await enterModelConfigPage(page);

	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });

	// 选 gemini（多方式）→ 进方式选择器
	await page.getByTestId('add-provider-item-gemini').click();
	await expect(page.getByTestId('add-method-chooser')).toBeVisible({ timeout: 10_000 });
	// 两个入口都在：api-key + oauth-login（浏览器登录，区别于设备码）
	await expect(page.getByTestId('add-method-api-key')).toBeVisible();
	await expect(page.getByTestId('add-method-oauth-login')).toBeVisible();

	// 点 oauth-login：当前"暂不支持"，不进配置子屏 → 仍停在方式选择器（不渲染 oauth-login-step / key 表单）
	await page.getByTestId('add-method-oauth-login').click();
	await expect(page.getByTestId('add-method-chooser')).toBeVisible();
	await expect(page.getByTestId('oauth-login-step')).toHaveCount(0);
	await expect(page.getByTestId('add-provider-key-input')).toHaveCount(0);

	// 返回：方式选择器的"返回"回到 provider 选择列表
	await page.getByTestId('add-method-back').click();
	await expect(page.getByTestId('add-provider-list')).toBeVisible({ timeout: 10_000 });
});
