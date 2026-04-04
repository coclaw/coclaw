import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('resolveApiBaseUrl', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	test('当 VITE_API_BASE_URL 有值时使用该配置', async () => {
		vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
		vi.mock('axios', () => ({
			default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } })) },
		}));
		const { resolveApiBaseUrl } = await import('./http.js');
		expect(resolveApiBaseUrl()).toBe('https://api.example.com');
	});

	test('当 VITE_API_BASE_URL 为空时使用 window.location.origin', async () => {
		vi.stubEnv('VITE_API_BASE_URL', '');
		vi.mock('axios', () => ({
			default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } })) },
		}));
		const { resolveApiBaseUrl } = await import('./http.js');
		expect(resolveApiBaseUrl()).toBe(window.location.origin);
	});

	test('当 window 未定义时返回 localhost fallback', async () => {
		vi.stubEnv('VITE_API_BASE_URL', '');
		vi.mock('axios', () => ({
			default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } })) },
		}));
		// 临时移除 window
		const origWindow = globalThis.window;
		// @ts-ignore
		delete globalThis.window;
		try {
			const { resolveApiBaseUrl } = await import('./http.js');
			expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
		} finally {
			globalThis.window = origWindow;
		}
	});
});

const mockAxiosInstance = vi.hoisted(() => ({
	interceptors: {
		request: { use: vi.fn() },
		response: { use: vi.fn() },
	},
}));

vi.mock('axios', () => ({
	default: {
		create: vi.fn(() => mockAxiosInstance),
	},
}));

import axios from 'axios';
import { httpClient } from './http.js';

describe('http client', () => {
	test('should create axios instance with withCredentials', () => {
		expect(axios.create).toHaveBeenCalledWith(
			expect.objectContaining({ withCredentials: true }),
		);
	});

	test('should export the shared client', () => {
		expect(httpClient).toBe(mockAxiosInstance);
	});

	test('should register request interceptor', () => {
		expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
	});

	test('should register response interceptor', () => {
		expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
	});

	describe('request interceptor', () => {
		let reqInterceptor;

		beforeEach(() => {
			reqInterceptor = mockAxiosInstance.interceptors.request.use.mock.calls[0][0];
		});

		test('should pass config through and log', () => {
			const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			const config = { method: 'get', url: '/api/test' };
			const result = reqInterceptor(config);
			expect(result).toBe(config);
			expect(spy).toHaveBeenCalledWith('[http] %s %s', 'GET', '/api/test');
			spy.mockRestore();
		});
	});

	describe('response interceptor', () => {
		let onFulfilled;
		let onRejected;

		beforeEach(() => {
			const call = mockAxiosInstance.interceptors.response.use.mock.calls[0];
			onFulfilled = call[0];
			onRejected = call[1];
		});

		test('should pass response through and log', () => {
			const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			const res = { status: 200, config: { method: 'post', url: '/api/foo' } };
			const result = onFulfilled(res);
			expect(result).toBe(res);
			expect(spy).toHaveBeenCalledWith('[http] %s %s → %d', 'POST', '/api/foo', 200);
			spy.mockRestore();
		});

		test('should reject error and warn', async () => {
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const err = {
				config: { method: 'get', url: '/api/bad' },
				response: { status: 404, data: { message: 'not found' } },
			};
			await expect(onRejected(err)).rejects.toBe(err);
			expect(spy).toHaveBeenCalledWith('[http] %s %s → %d %s', 'GET', '/api/bad', 404, 'not found');
			spy.mockRestore();
		});

		test('should dispatch auth:session-expired on 401', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
			const err = {
				config: { method: 'get', url: '/api/v1/bots' },
				response: { status: 401, data: { message: 'unauthorized' } },
			};
			await expect(onRejected(err)).rejects.toBe(err);
			const event = dispatchSpy.mock.calls.find(
				([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
			);
			expect(event).toBeTruthy();
			dispatchSpy.mockRestore();
		});

		test('should dispatch auth:session-expired for /user endpoint too', async () => {
			vi.useFakeTimers();
			vi.advanceTimersByTime(3001); // 跳过节流窗口
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
			const err = {
				config: { method: 'get', url: '/api/v1/user' },
				response: { status: 401, data: { message: 'unauthorized' } },
			};
			await expect(onRejected(err)).rejects.toBe(err);
			const event = dispatchSpy.mock.calls.find(
				([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
			);
			expect(event).toBeTruthy();
			dispatchSpy.mockRestore();
			vi.useRealTimers();
		});

		test('should NOT dispatch auth:session-expired for non-401 errors', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
			const err = {
				config: { method: 'get', url: '/api/v1/bots' },
				response: { status: 403, data: { message: 'forbidden' } },
			};
			await expect(onRejected(err)).rejects.toBe(err);
			const event = dispatchSpy.mock.calls.find(
				([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
			);
			expect(event).toBeFalsy();
			dispatchSpy.mockRestore();
		});

		test('should throttle auth:session-expired within 3s', async () => {
			vi.useFakeTimers();
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

			const makeErr = (url) => ({
				config: { method: 'get', url },
				response: { status: 401, data: {} },
			});

			// 第一次：跳过节流（距上次超过 3s）
			vi.advanceTimersByTime(3001);
			try { await onRejected(makeErr('/api/v1/bots')); } catch {}
			const count1 = dispatchSpy.mock.calls.filter(
				([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
			).length;

			// 第二次：500ms 内应被节流
			vi.advanceTimersByTime(500);
			try { await onRejected(makeErr('/api/v1/sessions')); } catch {}
			const count2 = dispatchSpy.mock.calls.filter(
				([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
			).length;

			expect(count2).toBe(count1); // 未增长

			dispatchSpy.mockRestore();
			vi.useRealTimers();
		});
	});
});
