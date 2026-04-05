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
	claimClaw,
	createBindingCode,
	listClaws,
	unbindClawByUser,
	waitBindingCode,
} from './claws.api.js';

describe('bots api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// listClaws
	test('listClaws 应返回 items 数组', async () => {
		mockedHttp.get.mockResolvedValue({
			data: { items: [{ id: 'bot1' }, { id: 'bot2' }] },
		});

		const result = await listClaws();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/claws');
		expect(result).toEqual([{ id: 'bot1' }, { id: 'bot2' }]);
	});

	test('listClaws 在 data.items 缺失时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: {} });

		const result = await listClaws();

		expect(result).toEqual([]);
	});

	test('listClaws 在 data 为 null 时应返回空数组', async () => {
		mockedHttp.get.mockResolvedValue({ data: null });

		const result = await listClaws();

		expect(result).toEqual([]);
	});

	// createBindingCode
	test('createBindingCode 应 POST 并返回 code/expiresAt/waitToken', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { code: 'ABC123', expiresAt: '2025-01-01T00:00:00Z', waitToken: 'tok' },
		});

		const result = await createBindingCode();

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/claws/binding-codes');
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
			data: { code: 'BINDING_SUCCESS', claw: { id: 'bot1' } },
		});

		const result = await waitBindingCode('ABC123', 'tok');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/claws/binding-codes/wait', {
			code: 'ABC123',
			waitToken: 'tok',
		});
		expect(result).toEqual({ code: 'BINDING_SUCCESS', claw: { id: 'bot1' } });
	});

	test('waitBindingCode 在 data 缺失时应使用默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await waitBindingCode('ABC123', 'tok');

		expect(result).toEqual({ code: 'BINDING_PENDING', claw: null });
	});

	test('waitBindingCode 在 data.claw 缺失时 claw 应为 null', async () => {
		mockedHttp.post.mockResolvedValue({ data: { code: 'BINDING_PENDING' } });

		const result = await waitBindingCode('ABC123', 'tok');

		expect(result.claw).toBeNull();
	});

	// cancelBindingCode
	test('cancelBindingCode 应 DELETE 正确路径', async () => {
		mockedHttp.delete.mockResolvedValue({});

		await cancelBindingCode('ABC123');

		expect(mockedHttp.delete).toHaveBeenCalledWith('/api/v1/claws/binding-codes/ABC123');
	});

	// claimClaw
	test('claimClaw 应 POST 带 code 并返回 clawId/clawName', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { clawId: 'b1', clawName: 'MyBot' },
		});

		const result = await claimClaw('ABC123');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/claws/claim', { code: 'ABC123' });
		expect(result).toEqual({ clawId: 'b1', clawName: 'MyBot' });
	});

	test('claimClaw 在 data 缺失时应返回 null 默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await claimClaw('ABC123');

		expect(result).toEqual({ clawId: null, clawName: null });
	});

	// unbindClawByUser
	test('unbindClawByUser 应 POST 带 clawId 并返回 clawId/status', async () => {
		mockedHttp.post.mockResolvedValue({
			data: { clawId: 'b1', status: 'unbound' },
		});

		const result = await unbindClawByUser('b1');

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/claws/unbind-by-user', { clawId: 'b1' });
		expect(result).toEqual({ clawId: 'b1', status: 'unbound' });
	});

	test('unbindClawByUser 在 data 缺失时应返回 null 默认值', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		const result = await unbindClawByUser('b1');

		expect(result).toEqual({ clawId: null, status: null });
	});
});
