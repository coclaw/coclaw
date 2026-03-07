import { beforeEach, describe, expect, test, vi } from 'vitest';

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
		expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
	});

	test('should register response interceptor', () => {
		expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
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
	});
});
