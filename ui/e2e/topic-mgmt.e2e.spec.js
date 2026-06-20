import { expect, test } from '@playwright/test';
import {
	login,
	navigateToMainChat,
	waitChatReady,
	typeText,
	evalStore,
	createTopicViaStore,
	deleteTopicViaStore,
} from './helpers.js';

/**
 * Topic 管理增量覆盖：重命名 / 删除 / 进入历史 topic 续聊
 *
 * 前置条件：
 * - server + OpenClaw gateway 运行中
 * - test 用户已绑定 claw 且在线（main agent）
 *
 * 数据安全：全部走 Create-Test-Delete——只操作本用例新建的 topic，用完即删；
 * 绝不触碰 main session 已有历史或其它已存在数据。
 */

/**
 * 进入桌面 main chat 页并返回 clawId（无在线 claw 返回 null，调用方据此 skip）。
 * 等输入框可用即表示首屏加载完成 + DC 就绪——createTopic / 后续发送都依赖就绪连接。
 */
async function enterMainChat(page) {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	const session = await navigateToMainChat(page);
	if (!session) return null;
	await waitChatReady(page);
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });
	return session.clawId;
}

/** 侧栏中某 topic 行（按 href 末段定位，locale 无关） */
function topicRow(page, topicId) {
	return page.locator(`aside [role="listitem"]:has(a[href$="/topics/${topicId}"])`);
}

// ================================================================
// Test 1: 重命名 topic
// ================================================================

test('Topic 重命名：新建 → 重命名 → 列表更新 @chat @ui', async ({ page }) => {
	test.setTimeout(120_000);
	const clawId = await enterMainChat(page);
	test.skip(!clawId, 'No chat session available (no claw online)');

	// 新建测试 topic（真实 RPC，不发消息）
	const topicId = await createTopicViaStore(page, clawId, 'main');
	expect(topicId).toBeTruthy();

	try {
		// 新 topic 入侧栏列表，默认标题为"新话题"
		const row = topicRow(page, topicId);
		await expect(row).toBeVisible({ timeout: 10_000 });

		// 悬停显示行内"更多操作"菜单按钮（行内唯一的 button；RouterLink 是 a）
		await row.hover();
		await row.getByRole('button').click();

		// 菜单首项为重命名（rename, delete 顺序固定）
		const menu = page.locator('.max-w-60');
		await menu.getByRole('button').filter({ hasText: /Rename|重命名/ }).click();

		// 重命名弹窗：输入唯一新标题并确认
		const renameDialog = page.getByRole('dialog');
		const newTitle = `e2e-rename-${Date.now()}`;
		const input = renameDialog.getByRole('textbox');
		await typeText(input, newTitle);
		await expect(input).toHaveValue(newTitle, { timeout: 3000 });
		await renameDialog.getByRole('button', { name: /^(Confirm|确认)$/ }).click();

		// 列表项标题更新为新标题
		await expect(row).toContainText(newTitle, { timeout: 10_000 });
	}
	finally {
		const ok = await deleteTopicViaStore(page, clawId, topicId);
		if (!ok) console.warn(`[topic-mgmt] cleanup failed for renamed topic ${topicId}`);
	}
});

// ================================================================
// Test 2: 删除 topic
// ================================================================

test('Topic 删除：新建 → 确认删除 → 从列表移除 @chat @ui', async ({ page }) => {
	test.setTimeout(120_000);
	const clawId = await enterMainChat(page);
	test.skip(!clawId, 'No chat session available (no claw online)');

	const topicId = await createTopicViaStore(page, clawId, 'main');
	expect(topicId).toBeTruthy();
	let removedViaUi = false;

	try {
		const row = topicRow(page, topicId);
		await expect(row).toBeVisible({ timeout: 10_000 });

		// 打开行内菜单 → 删除（菜单第二项）
		await row.hover();
		await row.getByRole('button').click();
		const menu = page.locator('.max-w-60');
		await menu.getByRole('button').filter({ hasText: /Delete|删除/ }).click();

		// 删除确认弹窗 → 确认
		const deleteDialog = page.getByRole('dialog').filter({ hasText: /Delete topic|删除话题/ });
		await expect(deleteDialog).toBeVisible({ timeout: 5000 });
		await deleteDialog.getByRole('button', { name: /^(Confirm|确认)$/ }).click();

		// 该 topic 行从侧栏列表移除
		await expect(row).toHaveCount(0, { timeout: 10_000 });
		removedViaUi = true;
	}
	finally {
		// UI 删除成功则无需再删；否则兜底清理（删一个不存在的 topic 由 plugin 返回 ok:false，
		// deleteTopicViaStore 吞掉异常返回 false，不影响判定）
		if (!removedViaUi) {
			const ok = await deleteTopicViaStore(page, clawId, topicId);
			if (!ok) console.warn(`[topic-mgmt] fallback cleanup failed for topic ${topicId}`);
		}
	}
});

// ================================================================
// Test 3: 进入历史 topic 继续对话
// ================================================================
//
// 通过"新建 topic 流程"发首条消息把 topic 落库为含内容的真实会话（空 topic 的
// coclaw.sessions.getById 会 NOT_FOUND、并非本场景语义），再离开后经 /topics/:sessionId
// 重新进入：既验"重新进入加载到既有历史"，又验"续聊一条并收到回复"——区别于现有
// topic-integration 仅覆盖的"新建并发送一次"。

test('历史 topic 续聊：重新进入已有内容的 topic 再续一条 @chat @ui', async ({ page }) => {
	test.setTimeout(420_000);
	const clawId = await enterMainChat(page);
	test.skip(!clawId, 'No chat session available (no claw online)');

	const msgItems = page.locator('[data-testid="chat-msg-item"]');
	let topicId = null;

	try {
		// 1) 经新建 topic 流程创建并发首条消息（该路径真正落库，使 topic 成为"已存在含内容"）
		await page.goto(`/topics/new?agent=main&claw=${clawId}`);
		const seedInput = page.getByTestId('chat-textarea');
		await expect(seedInput).toBeEnabled({ timeout: 30_000 });
		const msg1 = `e2e topic seed ${Date.now()}`;
		await typeText(seedInput, msg1);
		await expect(seedInput).toHaveValue(msg1, { timeout: 3000 });
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
		await page.getByTestId('btn-send').click();

		// 发送后路由由 /topics/new 切到 /topics/<uuid>
		await page.waitForURL((url) => /\/topics\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 30_000 });
		topicId = new URL(page.url()).pathname.split('/').pop();

		// 首条消息追加成功 + 首个回复完成（真实 agent 可能在回复里回显含唯一时间戳的原文，
		// 故消息项可能命中两处——取首个即用户气泡）
		await expect(msgItems.filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

		// 2) 离开（回 main session）再经侧栏列表项重新进入这个已存在 topic（in-app，连接保活）
		const mainLink = page.locator(`aside a[href$="/${clawId}/main"]`);
		await mainLink.click();
		await page.waitForURL(/\/chat\/[^/]+\/main$/, { timeout: 5000 });
		await waitChatReady(page);

		const topicLink = page.locator(`aside a[href$="/topics/${topicId}"]`);
		await expect(topicLink).toBeVisible({ timeout: 10_000 });
		await topicLink.click();
		await page.waitForURL(new RegExp(`/topics/${topicId}$`), { timeout: 5000 });
		await waitChatReady(page);

		// 重新进入应加载到既有历史（首条消息在列）—— 这是相对"新建并发送"的增量覆盖
		await expect(msgItems.filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 60_000 });
		const countAfterReenter = await msgItems.count();
		expect(countAfterReenter).toBeGreaterThanOrEqual(2); // 首条用户消息 + 首个回复

		// 3) 续聊一条并收到回复，断言追加成功
		const resumeInput = page.getByTestId('chat-textarea');
		await expect(resumeInput).toBeEnabled({ timeout: 30_000 });
		const msg2 = `e2e topic resume ${Date.now()}`;
		await typeText(resumeInput, msg2);
		await expect(resumeInput).toHaveValue(msg2, { timeout: 3000 });
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
		await page.getByTestId('btn-send').click();

		await expect(msgItems.filter({ hasText: msg2 }).first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
		await expect.poll(async () => msgItems.count(), { timeout: 10_000 }).toBeGreaterThan(countAfterReenter);
	}
	finally {
		if (topicId) {
			const ok = await deleteTopicViaStore(page, clawId, topicId);
			if (!ok) console.warn(`[topic-mgmt] cleanup failed for resumed topic ${topicId}`);
		}
	}
});

// ================================================================
// Test 4: 删除"当前正在查看"的 topic → 被路由推离该 topic
// ================================================================
//
// 现有删除用例都是在列表里删一个"未打开"的 topic。这里覆盖边角：用户正打开
// /topics/<id> 时删它，应被路由推走（TopicItemActions.onConfirmDelete 在
// route.name==='topics-chat' && params.sessionId===topicId 时 router.replace('/')）。

test('Topic 删除：删除当前打开的 topic → 路由离开该 topic @chat @ui', async ({ page }) => {
	test.setTimeout(120_000);
	const clawId = await enterMainChat(page);
	test.skip(!clawId, 'No chat session available (no claw online)');

	const topicId = await createTopicViaStore(page, clawId, 'main');
	expect(topicId).toBeTruthy();
	let removedViaUi = false;

	try {
		// 经侧栏进入这个 topic（空 topic 也会停在 /topics/<id>：__validateRoute 对
		// "已在 store 的 topic + 其 claw 在线"不会推走，NOT_FOUND 只是正文为空、不改路由）
		const row = topicRow(page, topicId);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await page.locator(`aside a[href$="/topics/${topicId}"]`).click();
		await page.waitForURL(new RegExp(`/topics/${topicId}$`), { timeout: 10_000 });

		// 从行内菜单删除"当前打开"的这个 topic
		await row.hover();
		await row.getByRole('button').click();
		const menu = page.locator('.max-w-60');
		await menu.getByRole('button').filter({ hasText: /Delete|删除/ }).click();
		const deleteDialog = page.getByRole('dialog').filter({ hasText: /Delete topic|删除话题/ });
		await expect(deleteDialog).toBeVisible({ timeout: 5000 });
		await deleteDialog.getByRole('button', { name: /^(Confirm|确认)$/ }).click();

		// 核心断言：删除当前打开的 topic 后，用户被路由推离 /topics/<topicId>
		await page.waitForURL((url) => !url.pathname.endsWith(`/topics/${topicId}`), { timeout: 10_000 });
		await expect(page).not.toHaveURL(new RegExp(`/topics/${topicId}$`));

		// 确认确实是被删除（store 里已没有该 topic），而非仅仅路由跳走
		const stillExists = await evalStore(page, 'topics', `return store.findTopic('${topicId}') != null;`);
		expect(stillExists).toBe(false);
		removedViaUi = true;
	}
	finally {
		// 已删则兜底删一个不存在的 topic 返回 false，无副作用
		if (!removedViaUi) {
			const ok = await deleteTopicViaStore(page, clawId, topicId);
			if (!ok) console.warn(`[topic-mgmt] fallback cleanup failed for open-topic ${topicId}`);
		}
	}
});

// ================================================================
// Test 5: 空白/纯空格重命名被拒、原标题不变
// ================================================================
//
// 重命名弹窗的确认钮 :disabled="!renameValue.trim()"，且 onConfirmRename 对空标题
// early-return：纯空格输入既无法点确认、也不会发 RPC。这里验"被拒 + 标题不变"。

test('Topic 重命名：纯空格标题被拒、原标题不变 @chat @ui', async ({ page }) => {
	test.setTimeout(120_000);
	const clawId = await enterMainChat(page);
	test.skip(!clawId, 'No chat session available (no claw online)');

	const topicId = await createTopicViaStore(page, clawId, 'main');
	expect(topicId).toBeTruthy();

	try {
		// 先给 topic 一个真实标题作基线，使"标题不变"的断言有意义（避免 null→null 空转）
		const baseTitle = `e2e-base-${Date.now()}`;
		await page.evaluate(async ({ clawId, topicId, title }) => {
			const { useTopicsStore } = await import('/src/stores/topics.store.js');
			await useTopicsStore().updateTopic(clawId, topicId, { title });
		}, { clawId, topicId, title: baseTitle });

		const row = topicRow(page, topicId);
		await expect(row).toContainText(baseTitle, { timeout: 10_000 });

		// 打开重命名弹窗
		await row.hover();
		await row.getByRole('button').click();
		const menu = page.locator('.max-w-60');
		await menu.getByRole('button').filter({ hasText: /Rename|重命名/ }).click();

		const renameDialog = page.getByRole('dialog');
		const input = renameDialog.getByRole('textbox');
		await expect(input).toBeVisible({ timeout: 5000 });

		// 输入纯空格（rename 框是 UInput，允许 fill）→ 确认钮被禁用 = 被拒
		await input.fill('   ');
		await expect(input).toHaveValue('   ', { timeout: 3000 });
		const confirmBtn = renameDialog.getByRole('button', { name: /^(Confirm|确认)$/ });
		await expect(confirmBtn).toBeDisabled();

		// 取消关闭弹窗，标题应保持基线值（store + 列表行均未变）
		await renameDialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
		const titleAfter = await evalStore(page, 'topics', `return store.findTopic('${topicId}')?.title ?? null;`);
		expect(titleAfter).toBe(baseTitle);
		await expect(row).toContainText(baseTitle, { timeout: 5000 });
	}
	finally {
		const ok = await deleteTopicViaStore(page, clawId, topicId);
		if (!ok) console.warn(`[topic-mgmt] cleanup failed for blank-rename topic ${topicId}`);
	}
});
