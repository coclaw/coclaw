import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';
import {
	MOCK_CATALOG,
	GROQ_PRIMARY,
	GROQ_PRIMARY_ALT,
	GROQ_PRIMARY_LABEL,
	GROQ_PRIMARY_ALT_LABEL,
	mockProfile,
	setupModelConfigMock,
	ensureMockReady,
	getOnlineClawId,
	waitDashboardSettled,
	tr,
} from './model-config-mock.js';

/**
 * 模型配置（model-config）E2E —— 设计 § 11 的 4 条必测场景。
 *
 * 数据保真度：model-config 的 6 个 RPC（providerAuth.list/setApiKey/remove、model.list/set、
 * models.list view:"all"）+ `status` 在 RPC 边界（ClawConnection.request）被 mock 成有状态合成响应
 * （详见 model-config-mock.js）；真实 claw 的连接 / 在线态 / dcReady / agents / sessions 仍走真实
 * WebRTC 链路。mock 不触碰 plugin 的 auth-profiles.json，跑完无任何真实 claw 残留。
 *
 * `status` 为何也合成：真实 status RPC 受 OpenClaw manifest-cache mismatch 影响每次卡 ~10s，会把
 * dashboard 的 loadDashboard 拖在飞行、触发 force-dedup 返回陈旧快照。合成 status 的 model/provider
 * 取自当前 mock primary。
 *
 * 保真度边界（明确告知）：AgentCard 的 modelLabel 由"合成 status（取自 mock primary）"驱动，因此它
 * 验证的是"UI 把已配主模型渲染进卡片"这条 UI 管线，**不**验证"plugin 真的把 model.set 持久化、
 * status 真的反映新模型"——后者属 plugin 侧，由 plugin 单测覆盖（E2E 不打真实 plugin 是为了不破坏
 * 测试 claw 不可恢复的真实 key）。本套件里"非自指"的外层断言是橙条引导 + dashboard store 派生字段
 * （由 providerAuth.list + model.list + catalog 驱动，与 status 无关）。
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

// ================================================================
// S1：首次接入主路径
// ================================================================
test('模型配置 S1：首次接入——橙条引导→配 key→选主模型→橙条消失+AgentCard 显示模型 @ui', async ({ page }) => {
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

	// 点"去配置"进子页
	await page.getByTestId(`guidance-go-${clawId}`).click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// 配第一个 API key：选 groq → 输入 key → 提交
	const addBtn = page.getByTestId('btn-add-provider');
	await expect(addBtn).toBeEnabled({ timeout: 30_000 });
	await addBtn.click();
	await expect(page.getByTestId('add-provider-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('add-provider-item-groq').click();
	const keyInput = page.getByTestId('add-provider-key-input');
	await keyInput.click();
	await keyInput.pressSequentially('sk-test-0000111122223333', { delay: 10 });
	await page.getByTestId('add-provider-submit').click();
	await expect(page.getByTestId('add-provider-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 凭据行出现
	await expect(page.getByText('Groq', { exact: true })).toBeVisible({ timeout: 10_000 });

	// 等 add 触发的外层 dashboard 重拉落定后再 pick：否则 add(primary=null) 的飞行刷新
	// 会被 pick 的 loadDashboard(force) 去重命中，外层卡在陈旧的"未配主模型"
	await waitDashboardSettled(page, clawId, { hasAny: true });

	// 还没主模型 → 选主模型
	const selBtn = page.getByTestId('btn-primary-select');
	await expect(selBtn).toBeVisible({ timeout: 10_000 });
	await selBtn.click();
	await expect(page.getByTestId('primary-picker-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId(`primary-picker-item-groq__${GROQ_PRIMARY.split('/')[1]}`).click();
	await expect(page.getByTestId('primary-picker-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 子页主模型区即时反映
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY);

	// 仍在子页时先断言 store 已被写回调（onPrimaryPicked）的 loadDashboard(force) 刷成"有效主模型"——
	// 这把"写回调强刷新路径"本身锁住；否则后面 /claws 挂载时的 loadData 会把断言救活、掩盖回调回归
	await waitDashboardSettled(page, clawId, { hasAny: true, primaryModel: GROQ_PRIMARY, primaryEffective: true });

	// 返回 ManageClaws（SPA，连接存活）：外层 UI 一致性追上
	await spaGo(page, '/claws');
	await waitDashReady(page, clawId);
	// 橙条消失（橙条由 providerAuth.list + model.list + catalog 驱动，与 status 无关 → 非自指断言）
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });
	// AgentCard 显示新 modelLabel
	await expect(page.locator(`[data-testid="claw-${clawId}"]`).getByText(GROQ_PRIMARY_LABEL).first())
		.toBeVisible({ timeout: 30_000 });
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

	// 齿轮进子页
	const gear = page.getByTestId(`btn-model-config-${clawId}`);
	await expect(gear).toBeEnabled({ timeout: 30_000 });
	await gear.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });

	// 子页：主模型有效、两个凭据行
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY, { timeout: 30_000 });
	// profiles[0] = groq（mock 固定顺序，ModelConfigPage 不排序）；即便选错行，下方"强提示分支"
	// 断言（confirmButtonStrong + descAffectPrimary 含 Groq/primary）也会失败，故选错行不会漏过
	const firstRemove = page.getByTestId('btn-remove-provider').first();
	await expect(firstRemove).toBeEnabled({ timeout: 30_000 });
	await firstRemove.click();

	// 强提示分支：确认按钮文案 = "Remove anyway"，正文含"runs on Groq" + 当前 primary 串
	const confirm = page.getByTestId('btn-remove-confirm');
	await expect(confirm).toBeVisible({ timeout: 10_000 });
	// 强提示分支：确认按钮是"仍然撤销"变体 + 正文出现强提示文案（含当前 primary 串）
	await expect(confirm).toHaveText(await tr(page, 'modelConfig.providerAuth.remove.confirmButtonStrong'));
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText(
		await tr(page, 'modelConfig.providerAuth.remove.descAffectPrimary', { primary: GROQ_PRIMARY, provider: 'Groq' })
	);
	await confirm.click();
	await expect(page.getByTestId('btn-remove-confirm')).not.toBeVisible({ timeout: 15_000 });

	// 子页：groq 行消失、anthropic 保留、主模型区切"失效"
	await expect(page.getByText('Groq', { exact: true })).toHaveCount(0, { timeout: 15_000 });
	await expect(page.getByText('Anthropic Claude')).toBeVisible();
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
test('模型配置 S3：切换主模型——无二次确认→toast→子页与外层 AgentCard 即时更新 @ui', async ({ page }) => {
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

	// 齿轮进子页
	const gear = page.getByTestId(`btn-model-config-${clawId}`);
	await expect(gear).toBeEnabled({ timeout: 30_000 });
	await gear.click();
	await page.waitForURL(new RegExp(`/claws/${clawId}/models`), { timeout: 15_000 });
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY, { timeout: 30_000 });

	// 换模型：点"更换"→ picker → 点另一个模型
	const changeBtn = page.getByTestId('btn-primary-change');
	await expect(changeBtn).toBeEnabled({ timeout: 30_000 });
	await changeBtn.click();
	await expect(page.getByTestId('primary-picker-dialog')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId(`primary-picker-item-groq__${GROQ_PRIMARY_ALT.split('/')[1]}`).click();
	// 无二次确认：点击后 picker 直接关闭
	await expect(page.getByTestId('primary-picker-dialog')).not.toBeVisible({ timeout: 15_000 });
	// 负向断言：picker 关闭后不存在任何对话框（含二次确认 modal）——锁死"选完即存、无二次确认"
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// toast（exact 只命中可见 title，避开 a11y live-region 那份 "Notification […]" 文本）
	await expect(page.getByText(await tr(page, 'modelConfig.primary.changeSuccess'), { exact: true }).first())
		.toBeVisible({ timeout: 5_000 });
	// 子页即时更新
	await expect(page.getByTestId('primary-current')).toHaveText(GROQ_PRIMARY_ALT);

	// 仍在子页时断言 store 已被写回调（onPrimaryPicked）的 loadDashboard(force) 刷成新主模型——
	// 锁住写回调的强刷新路径（不依赖随后 /claws 挂载的 loadData 救活断言）
	await waitDashboardSettled(page, clawId, { primaryModel: GROQ_PRIMARY_ALT, primaryEffective: true });

	// 外层（SPA 返回，连接存活）：主模型仍有效 → 橙条保持不出现（非自指：由 model.list+catalog 驱动）
	await spaGo(page, '/claws');
	await waitDashReady(page, clawId);
	await expect(page.getByTestId(`guidance-${clawId}`)).toHaveCount(0, { timeout: 30_000 });
	// AgentCard 反映新模型（注：modelLabel 由合成 status 驱动，见文件头"保真度边界"）
	await expect(page.locator(`[data-testid="claw-${clawId}"]`).getByText(GROQ_PRIMARY_ALT_LABEL).first())
		.toBeVisible({ timeout: 30_000 });
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
