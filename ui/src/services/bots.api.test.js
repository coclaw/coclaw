import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import {
	cancelBindingCode,
	claimBot,
	createBindingCode,
	listBots,
	unbindBotByUser,
	waitBindingCode,
} from './bots.api.js';

describe('bots api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// listBots
	test('listBots 应返回 items 数组', async () => {
		mockedHttp.get.mockResolvedValue({
			data: { items: [{ id: 'bot1' }, { id: 'bot2' }] },
		});

		const result = await listBots();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/bots');
		expect(result).toEqual([{ id: 'bot1' }, { id: 'bot2' }]);
	});

	test('listBots 在 data.items 缺失时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: {} });

		const result = await listBots();

		expect(result).toEqual([]);
	});

	test('listBots 在 data 为 null 时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: null });

		const result = await listBots();

		expect(result).toEqual([]);
	});

	// createBindingCode
	test('createBindingCode 应 POST 并返回 code/expiresAt/waitToken', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { code: 'ABC123', expiresAt: '2025-01-01T00:00:00Z', waitToken: 'tok' },
		});

		const result = await createBindingCode();

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/bots/binding-codes');
		expect(result).toEqual({
			code: 'ABC123',
			expiresAt: '2025-01-01T00:00:00Z',
			waitToken: 'tok',
		});
	});

	test('createBindingCode 在 data 缺失时应返回默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await createBindingCode();

		expect(result).toEqual({ code: '', expiresAt: null, waitToken: '' });
	});

	test('createBindingCode 在 data 字段部分缺失时应使用默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: { code: 'X1' } });

		const result = await createBindingCode();

		expect(result.code).toBe('X1');
		expect(result.expiresAt).toBeNull();
		expect(result.waitToken).toBe('');
	});

	// waitBindingCode
	test('waitBindingCode 应 POST 带 code/waitToken 并返回结果', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { code: 'BINDING_SUCCESS', bot: { id: 'bot1' } },
		});

		const result = await waitBindingCode('ABC123', 'tok');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/bots/binding-codes/wait', {
			code: 'ABC123',
			waitToken: 'tok',
		});
		expect(result).toEqual({ code: 'BINDING_SUCCESS', bot: { id: 'bot1' } });
	});

	test('waitBindingCode 在 data 缺失时应使用默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await waitBindingCode('ABC123', 'tok');

		expect(result).toEqual({ code: 'BINDING_PENDING', bot: null });
	});

	test('waitBindingCode 在 data.bot 缺失时 bot 应为 null', async () => {
		mockedHttp.post.mockResolvedValue({ data: { code: 'BINDING_PENDING' } });

		const result = await waitBindingCode('ABC123', 'tok');

		expect(result.bot).toBeNull();
	});

	// cancelBindingCode
	test('cancelBindingCode 应 DELETE 正确路径', async () => {
		mockedHttp.delete.mockResolvedValue({});

		await cancelBindingCode('ABC123');

		expect(mockedHttp.delete).toHaveBeenCalledWith('/api/v1/bots/binding-codes/ABC123');
	});

	// claimBot
	test('claimBot 应 POST 带 code 并返回 botId/botName', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { botId: 'b1', botName: 'MyBot' },
		});

		const result = await claimBot('ABC123');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/claws/claim', { code: 'ABC123' });
		expect(result).toEqual({ botId: 'b1', botName: 'MyBot' });
	});

	test('claimBot 在 data 缺失时应返回 null 默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await claimBot('ABC123');

		expect(result).toEqual({ botId: null, botName: null });
	});

	// unbindBotByUser
	test('unbindBotByUser 应 POST 带 botId 并返回 botId/status', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { botId: 'b1', status: 'unbound' },
		});

		const result = await unbindBotByUser('b1');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/bots/unbind-by-user', { botId: 'b1' });
		expect(result).toEqual({ botId: 'b1', status: 'unbound' });
	});

	test('unbindBotByUser 在 data 缺失时应返回 null 默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await unbindBotByUser('b1');

		expect(result).toEqual({ botId: null, status: null });
	});
});
