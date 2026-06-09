import { test, expect } from '@playwright/test';
import { login, TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';
import { loginAndGetCookies, sweepOrphans } from './claw-cleanup.js';

const SERVER = 'http://127.0.0.1:3000';

async function serverPost(path, body, cookies) {
	const res = await fetch(`${SERVER}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(cookies ? { cookie: cookies } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, data: await res.json() };
}

// 仅删除本轮测试新建的 claw（基线 diff），不动基线里的真实绑定。
// 基线未抓取时 sweepOrphans 自动跳过，故此处也不会误删。
async function ensureUnbound(cookies) {
	await sweepOrphans(cookies);
}

async function createClaimCode() {
	const res = await serverPost('/api/v1/claws/claim-codes');
	return res.data;
}

test.describe('Claim Page @bind', () => {
	// 造 claw 的用例（claim 成功 / 登录回跳）本不该留下 claw，结束后删除本轮新建的孤儿。
	// 容错：afterEach 内异常只 warn，不连累用例结果。
	test.afterEach(async () => {
		try {
			const cookies = await loginAndGetCookies();
			await sweepOrphans(cookies);
		}
		catch (err) {
			console.warn('[e2e-cleanup] claim afterEach sweep failed:', err?.message);
		}
	});

	test('should show noCode state when no code in query', async ({ page }) => {
		await login(page);
		await page.goto('/claim');
		// 断言 locale 无关的稳定锚点（testid），不匹配文案——文案随语言变化会脆断
		await expect(page.getByTestId('claim-no-code')).toBeVisible({ timeout: 5000 });
	});

	test('should claim successfully and navigate to /claws', async ({ page }) => {
		// 准备：登录、解绑、创建认领码
		const cookies = await loginAndGetCookies();
		await ensureUnbound(cookies);
		const { code } = await createClaimCode();

		await login(page);
		await page.goto(`/claim?code=${code}`);

		// 等待成功状态
		await expect(page.locator('main')).toContainText(/success|成功/i, { timeout: 10_000 });

		// 自动跳转到 /claws
		await expect(page).toHaveURL(/\/claws/, { timeout: 5000 });
	});

	test('should show error for invalid code', async ({ page }) => {
		await login(page);
		await page.goto('/claim?code=00000000');
		await expect(page.locator('main')).toContainText(/invalid|无效/i, { timeout: 5000 });
	});

	test('should redirect to login then back to claim when not authenticated', async ({ page }) => {
		const cookies = await loginAndGetCookies();
		await ensureUnbound(cookies);
		const { code } = await createClaimCode();

		// 直接访问 /claim（未登录）
		await page.goto(`/claim?code=${code}`);

		// 应该被重定向到 /login，且 URL 包含 redirect 参数
		await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
		const loginUrl = page.url();
		expect(loginUrl).toContain('redirect');
		expect(loginUrl).toContain(`/claim?code=${code}`);

		// 登录
		await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
		await page.getByTestId('login-password').fill(TEST_PASSWORD);
		await page.getByTestId('btn-login').click();

		// 登录后应回到 /claim 并完成认领
		await expect(page).toHaveURL(/\/claim/, { timeout: 10_000 });
		await expect(page.locator('main')).toContainText(/success|成功/i, { timeout: 10_000 });
	});
});
