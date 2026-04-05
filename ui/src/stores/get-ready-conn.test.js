import { test, expect, describe, vi, beforeEach } from 'vitest';

let botsById = {};
vi.mock('./claws.store.js', () => ({
	useClawsStore: () => ({ byId: botsById }),
}));

const connectionsMap = new Map();
vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => connectionsMap,
}));

import { getReadyConn } from './get-ready-conn.js';

beforeEach(() => {
	botsById = {};
	connectionsMap.clear();
});

describe('getReadyConn', () => {
	test('bot 存在且 dcReady=true，连接存在 → 返回连接', () => {
		const conn = { id: 'conn-1' };
		botsById['b1'] = { dcReady: true };
		connectionsMap.set('b1', conn);

		expect(getReadyConn('b1')).toBe(conn);
	});

	test('bot 存在但 dcReady=false → 返回 null', () => {
		botsById['b2'] = { dcReady: false };
		connectionsMap.set('b2', { id: 'conn-2' });

		expect(getReadyConn('b2')).toBeNull();
	});

	test('bot 不存在 → 返回 null', () => {
		expect(getReadyConn('non-existent')).toBeNull();
	});

	test('dcReady=true 但连接不存在 → 返回 null', () => {
		botsById['b3'] = { dcReady: true };
		// connectionsMap 中没有 b3

		expect(getReadyConn('b3')).toBeNull();
	});

	test('clawId 为数字时自动转为字符串查找', () => {
		const conn = { id: 'conn-num' };
		botsById['42'] = { dcReady: true };
		connectionsMap.set('42', conn);

		expect(getReadyConn(42)).toBe(conn);
	});
});
