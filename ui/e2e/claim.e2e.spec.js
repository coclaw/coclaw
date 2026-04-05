import { test, expect } from '@playwright/test';
import { login, TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';

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

async function loginAndGetCookies() {
	const res = await fetch(`${SERVER}/api/v1/auth/local/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ loginName: TEST_LOGIN_NAME, password: TEST_PASSWORD }),
	});
	const setCookie = res.headers.getSetCookie?.() ?? [];
	return setCookie.map(c => c.split(';')[0]).join('; ');
}

async function ensureUnbound(cookies) {
	const res = await fetch(`${SERVER}/api/v1/claws`, {
		headers: { cookie: cookies },
	});
	const data = await res.json();
	for (const claw of (data.items || [])) {
		await serverPost('/api/v1/claws/unbind-by-user', { clawId: claw.id }, cookies);
	}
}

async function createClaimCode() {
	const res = await serverPost('/api/v1/claws/claim-codes');
	return res.data;
}

test.describe('Claim Page @bind', () => {
	test('should show noCode state when no code in query', async ({ page }) => {
		await login(page);
		await page.goto('/claim');
		await expect(page.locator('main')).toContainText(/no code|认领码/i, { timeout: 5000 });
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

	test('should show already bound error', async ({ page }) => {
		// 先确保已绑定
		const cookies = await loginAndGetCookies();
		await ensureUnbound(cookies);
		const { code: code1 } = await createClaimCode();
		await serverPost('/api/v1/claws/claim', { code: code1 }, cookies);

		// 再次认领应失败
		const { code: code2 } = await createClaimCode();
		await login(page);
		await page.goto(`/claim?code=${code2}`);
		await expect(page.locator('main')).toContainText(/already bound|已绑定/i, { timeout: 5000 });
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
