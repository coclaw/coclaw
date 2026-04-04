import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['src/**/*.test.js'],
		exclude: ['e2e/**'],
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./vitest.setup.js'],
		coverage: {
			include: [
				'src/stores/**/*.js',
				'src/services/**/*.js',
				'src/utils/**/*.js',
				'src/composables/**/*.js',
				'src/validators/**/*.js',
			],
			provider: 'v8',
			reporter: ['text', 'lcov'],
			exclude: [
				'e2e/**',
				'playwright.config.js',
				'vitest.config.js',
				'vite.config.js',
				'src/utils/tauri-app.js',
				'src/utils/tauri-notify.js',
			],
			thresholds: {
				lines: 95,
				functions: 95,
				branches: 90,
				statements: 95,
			},
		},
	},
});
