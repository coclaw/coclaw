import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	retries: 0,
	workers: 1,
	globalSetup: './e2e/global-setup.js',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		headless: true,
	},
	webServer: [
		{
			command: 'pnpm --filter @coclaw/server exec cross-env NODE_ENV=development node src/index.js',
			port: 3000,
			reuseExistingServer: true,
			timeout: 120_000,
		},
		{
			command: 'pnpm dev --host 127.0.0.1 --port 4173',
			port: 4173,
			reuseExistingServer: true,
			timeout: 120_000,
		},
	],
});
