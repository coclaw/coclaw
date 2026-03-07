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
			include: ['src/stores/**/*.js', 'src/services/**/*.js'],
			provider: 'v8',
			reporter: ['text', 'lcov'],
			exclude: [
				'e2e/**',
				'playwright.config.js',
				'vitest.config.js',
				'vite.config.js',
			],
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 60,
				statements: 70,
			},
		},
	},
});
