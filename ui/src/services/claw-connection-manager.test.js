import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useClawConnections, __resetClawConnections, ClawConnectionManager } from './claw-connection-manager.js';

vi.mock('./claw-connection.js', () => {
	class MockClawConnection {
		constructor(clawId) {
			this.clawId = clawId;
			this.disconnected = false;
		}
		disconnect() { this.disconnected = true; }
		on() {}
		off() {}
	}
	return { ClawConnection: MockClawConnection, BRIEF_DISCONNECT_MS: 5000 };
});

vi.mock('./signaling-connection.js', () => ({
	useSignalingConnection: () => ({ state: 'connected' }),
}));

beforeEach(() => {
	__resetClawConnections();
});

describe('useClawConnections()', () => {
	test('返回单例', () => {
		const a = useClawConnections();
		const b = useClawConnections();
		expect(a).toBe(b);
	});

	test('返回 ClawConnectionManager 实例', () => {
		expect(useClawConnections()).toBeInstanceOf(ClawConnectionManager);
	});
});

describe('__resetClawConnections()', () => {
	test('重置后 useClawConnections() 返回新实例', () => {
		const a = useClawConnections();
		__resetClawConnections();
		const b = useClawConnections();
		expect(a).not.toBe(b);
	});

	test('重置时断开所有现有连接', () => {
		const mgr = useClawConnections();
		const conn = mgr.connect('bot-1');
		__resetClawConnections();
		expect(conn.disconnected).toBe(true);
	});

	test('重置空单例不报错', () => {
		// instance 已被 beforeEach 重置为 null，再次重置应无副作用
		expect(() => __resetClawConnections()).not.toThrow();
	});
});

describe('connect(clawId)', () => {
	test('创建连接实例', () => {
		const mgr = useClawConnections();
		const conn = mgr.connect('bot-1');
		expect(conn).toBeDefined();
		expect(conn.clawId).toBe('bot-1');
	});

	test('幂等：第二次 connect 返回同一实例', () => {
		const mgr = useClawConnections();
		const first = mgr.connect('bot-1');
		const second = mgr.connect('bot-1');
		expect(first).toBe(second);
	});

	test('数字 clawId 被转换为字符串', () => {
		const mgr = useClawConnections();
		const conn = mgr.connect(42);
		expect(conn.clawId).toBe('42');
		// 用字符串也能找到同一实例
		expect(mgr.get('42')).toBe(conn);
	});

	test('不同 clawId 创建独立连接', () => {
		const mgr = useClawConnections();
		const c1 = mgr.connect('bot-1');
		const c2 = mgr.connect('bot-2');
		expect(c1).not.toBe(c2);
	});
});

describe('disconnect(clawId)', () => {
	test('调用连接的 disconnect() 并从 manager 移除', () => {
		const mgr = useClawConnections();
		const conn = mgr.connect('bot-1');
		mgr.disconnect('bot-1');
		expect(conn.disconnected).toBe(true);
		expect(mgr.get('bot-1')).toBeUndefined();
	});

	test('对不存在的 clawId 不报错', () => {
		const mgr = useClawConnections();
		expect(() => mgr.disconnect('no-such-bot')).not.toThrow();
	});

	test('数字 clawId 正常断开', () => {
		const mgr = useClawConnections();
		mgr.connect(7);
		mgr.disconnect(7);
		expect(mgr.get('7')).toBeUndefined();
	});
});

describe('get(clawId)', () => {
	test('返回已建立的连接', () => {
		const mgr = useClawConnections();
		const conn = mgr.connect('bot-1');
		expect(mgr.get('bot-1')).toBe(conn);
	});

	test('不存在时返回 undefined', () => {
		const mgr = useClawConnections();
		expect(mgr.get('ghost')).toBeUndefined();
	});

	test('断开后返回 undefined', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.disconnect('bot-1');
		expect(mgr.get('bot-1')).toBeUndefined();
	});
});

describe('syncConnections(clawIds)', () => {
	test('连接新增的 bot', () => {
		const mgr = useClawConnections();
		mgr.syncConnections(['bot-1', 'bot-2']);
		expect(mgr.get('bot-1')).toBeDefined();
		expect(mgr.get('bot-2')).toBeDefined();
		expect(mgr.size).toBe(2);
	});

	test('断开已移除的 bot', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		const old = mgr.get('bot-2');
		mgr.syncConnections(['bot-1']);
		expect(mgr.get('bot-1')).toBeDefined();
		expect(mgr.get('bot-2')).toBeUndefined();
		expect(old.disconnected).toBe(true);
	});

	test('不重复连接已存在的 bot', () => {
		const mgr = useClawConnections();
		const existing = mgr.connect('bot-1');
		mgr.syncConnections(['bot-1', 'bot-2']);
		expect(mgr.get('bot-1')).toBe(existing);
		expect(mgr.size).toBe(2);
	});

	test('传入空数组时断开所有连接', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.syncConnections([]);
		expect(mgr.size).toBe(0);
	});

	test('重复 clawId 只建立一个连接', () => {
		const mgr = useClawConnections();
		mgr.syncConnections(['bot-1', 'bot-1']);
		expect(mgr.size).toBe(1);
	});
});

describe('disconnectAll()', () => {
	test('断开所有连接并清空 manager', () => {
		const mgr = useClawConnections();
		const c1 = mgr.connect('bot-1');
		const c2 = mgr.connect('bot-2');
		mgr.disconnectAll();
		expect(c1.disconnected).toBe(true);
		expect(c2.disconnected).toBe(true);
		expect(mgr.size).toBe(0);
	});

	test('无连接时不报错', () => {
		const mgr = useClawConnections();
		expect(() => mgr.disconnectAll()).not.toThrow();
	});
});

describe('getStates()', () => {
	test('返回所有连接的 clawId → signaling WS state 映射', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		const states = mgr.getStates();
		expect(states).toEqual({ 'bot-1': 'connected', 'bot-2': 'connected' });
	});

	test('无连接时返回空对象', () => {
		const mgr = useClawConnections();
		expect(mgr.getStates()).toEqual({});
	});

	test('断开连接后不再出现在 getStates() 中', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnect('bot-1');
		expect(mgr.getStates()).toEqual({ 'bot-2': 'connected' });
	});
});

describe('size', () => {
	test('初始为 0', () => {
		expect(useClawConnections().size).toBe(0);
	});

	test('随连接增加', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		expect(mgr.size).toBe(2);
	});

	test('随断开减少', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnect('bot-1');
		expect(mgr.size).toBe(1);
	});

	test('disconnectAll 后归零', () => {
		const mgr = useClawConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnectAll();
		expect(mgr.size).toBe(0);
	});
});
