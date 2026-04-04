import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	get: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import { fetchServerInfo } from './server-info.api.js';

describe('server-info api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('fetchServerInfo 应 GET 正确路径并返回 data', async () => {
		const info = { version: '1.2.3', name: 'CoClaw Server' };
		mockedHttp.get.mockResolvedValue({ data: info });

		const result = await fetchServerInfo();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/info');
		expect(result).toEqual(info);
	});

	test('fetchServerInfo 在 data 为 null 时应返回 null', async () => {
		mockedHttp.get.mockResolvedValue({ data: null });

		const result = await fetchServerInfo();

		expect(result).toBeNull();
	});
});
