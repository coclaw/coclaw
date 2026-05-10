// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import { hideWebAgent, listWebAgents, recordWebAgentClick } from './web-agents.api.js';

describe('web-agents api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('listWebAgents 应 GET 并返回 items', async () => {
		mockedHttp.get.mockResolvedValue({
			data: { items: [{ id: 1, slug: 'deepseek' }, { id: 2, slug: 'doubao' }] },
		});

		const result = await listWebAgents();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/web-agents');
		expect(result).toEqual([{ id: 1, slug: 'deepseek' }, { id: 2, slug: 'doubao' }]);
	});

	test('listWebAgents 在 data.items 缺失时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: {} });
		const result = await listWebAgents();
		expect(result).toEqual([]);
	});

	test('listWebAgents 在 data 为 null 时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: null });
		const result = await listWebAgents();
		expect(result).toEqual([]);
	});

	test('recordWebAgentClick 应 POST 到 /:id/click', async () => {
		mockedHttp.post.mockResolvedValue({ status: 204 });
		await recordWebAgentClick(7);
		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/web-agents/7/click');
	});

	test('recordWebAgentClick 失败时透传 reject', async () => {
		const err = new Error('boom');
		mockedHttp.post.mockRejectedValue(err);
		await expect(recordWebAgentClick(9)).rejects.toThrow('boom');
	});

	test('listWebAgents 网络错误透传 reject（确保上层 store 能捕获）', async () => {
		mockedHttp.get.mockRejectedValue(new Error('Network Error'));
		await expect(listWebAgents()).rejects.toThrow('Network Error');
	});

	test('hideWebAgent 应 POST 到 /:id/hide', async () => {
		mockedHttp.post.mockResolvedValue({ status: 204 });
		await hideWebAgent(11);
		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/web-agents/11/hide');
	});

	test('hideWebAgent 失败时透传 reject', async () => {
		mockedHttp.post.mockRejectedValue(new Error('boom'));
		await expect(hideWebAgent(12)).rejects.toThrow('boom');
	});
});
