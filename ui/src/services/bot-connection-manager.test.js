import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useBotConnections, __resetBotConnections, BotConnectionManager } from './bot-connection-manager.js';

vi.mock('./bot-connection.js', () => {
	class MockBotConnection {
		constructor(botId) {
			this.botId = botId;
			this.state = 'disconnected';
		}
		connect() { this.state = 'connecting'; }
		disconnect() { this.state = 'disconnected'; }
		on() {}
		off() {}
	}
	return { BotConnection: MockBotConnection };
});

beforeEach(() => {
	__resetBotConnections();
});

describe('useBotConnections()', () => {
	test('返回单例', () => {
		const a = useBotConnections();
		const b = useBotConnections();
		expect(a).toBe(b);
	});

	test('返回 BotConnectionManager 实例', () => {
		expect(useBotConnections()).toBeInstanceOf(BotConnectionManager);
	});
});

describe('__resetBotConnections()', () => {
	test('重置后 useBotConnections() 返回新实例', () => {
		const a = useBotConnections();
		__resetBotConnections();
		const b = useBotConnections();
		expect(a).not.toBe(b);
	});

	test('重置时断开所有现有连接', () => {
		const mgr = useBotConnections();
		const conn = mgr.connect('bot-1');
		expect(conn.state).toBe('connecting');
		__resetBotConnections();
		expect(conn.state).toBe('disconnected');
	});

	test('重置空单例不报错', () => {
		// instance 已被 beforeEach 重置为 null，再次重置应无副作用
		expect(() => __resetBotConnections()).not.toThrow();
	});
});

describe('connect(botId)', () => {
	test('创建连接并调用 connect()', () => {
		const mgr = useBotConnections();
		const conn = mgr.connect('bot-1');
		expect(conn).toBeDefined();
		expect(conn.botId).toBe('bot-1');
		expect(conn.state).toBe('connecting');
	});

	test('幂等：第二次 connect 返回同一实例', () => {
		const mgr = useBotConnections();
		const first = mgr.connect('bot-1');
		const second = mgr.connect('bot-1');
		expect(first).toBe(second);
	});

	test('数字 botId 被转换为字符串', () => {
		const mgr = useBotConnections();
		const conn = mgr.connect(42);
		expect(conn.botId).toBe('42');
		// 用字符串也能找到同一实例
		expect(mgr.get('42')).toBe(conn);
	});

	test('不同 botId 创建独立连接', () => {
		const mgr = useBotConnections();
		const c1 = mgr.connect('bot-1');
		const c2 = mgr.connect('bot-2');
		expect(c1).not.toBe(c2);
	});
});

describe('disconnect(botId)', () => {
	test('调用连接的 disconnect() 并从 manager 移除', () => {
		const mgr = useBotConnections();
		const conn = mgr.connect('bot-1');
		mgr.disconnect('bot-1');
		expect(conn.state).toBe('disconnected');
		expect(mgr.get('bot-1')).toBeUndefined();
	});

	test('对不存在的 botId 不报错', () => {
		const mgr = useBotConnections();
		expect(() => mgr.disconnect('no-such-bot')).not.toThrow();
	});

	test('数字 botId 正常断开', () => {
		const mgr = useBotConnections();
		mgr.connect(7);
		mgr.disconnect(7);
		expect(mgr.get('7')).toBeUndefined();
	});
});

describe('get(botId)', () => {
	test('返回已建立的连接', () => {
		const mgr = useBotConnections();
		const conn = mgr.connect('bot-1');
		expect(mgr.get('bot-1')).toBe(conn);
	});

	test('不存在时返回 undefined', () => {
		const mgr = useBotConnections();
		expect(mgr.get('ghost')).toBeUndefined();
	});

	test('断开后返回 undefined', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.disconnect('bot-1');
		expect(mgr.get('bot-1')).toBeUndefined();
	});
});

describe('syncConnections(botIds)', () => {
	test('连接新增的 bot', () => {
		const mgr = useBotConnections();
		mgr.syncConnections(['bot-1', 'bot-2']);
		expect(mgr.get('bot-1')).toBeDefined();
		expect(mgr.get('bot-2')).toBeDefined();
		expect(mgr.size).toBe(2);
	});

	test('断开已移除的 bot', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		const old = mgr.get('bot-2');
		mgr.syncConnections(['bot-1']);
		expect(mgr.get('bot-1')).toBeDefined();
		expect(mgr.get('bot-2')).toBeUndefined();
		expect(old.state).toBe('disconnected');
	});

	test('不重复连接已存在的 bot', () => {
		const mgr = useBotConnections();
		const existing = mgr.connect('bot-1');
		mgr.syncConnections(['bot-1', 'bot-2']);
		expect(mgr.get('bot-1')).toBe(existing);
		expect(mgr.size).toBe(2);
	});

	test('传入空数组时断开所有连接', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.syncConnections([]);
		expect(mgr.size).toBe(0);
	});

	test('重复 botId 只建立一个连接', () => {
		const mgr = useBotConnections();
		mgr.syncConnections(['bot-1', 'bot-1']);
		expect(mgr.size).toBe(1);
	});
});

describe('disconnectAll()', () => {
	test('断开所有连接并清空 manager', () => {
		const mgr = useBotConnections();
		const c1 = mgr.connect('bot-1');
		const c2 = mgr.connect('bot-2');
		mgr.disconnectAll();
		expect(c1.state).toBe('disconnected');
		expect(c2.state).toBe('disconnected');
		expect(mgr.size).toBe(0);
	});

	test('无连接时不报错', () => {
		const mgr = useBotConnections();
		expect(() => mgr.disconnectAll()).not.toThrow();
	});
});

describe('getStates()', () => {
	test('返回所有连接的 botId → state 映射', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		const states = mgr.getStates();
		expect(states).toEqual({ 'bot-1': 'connecting', 'bot-2': 'connecting' });
	});

	test('无连接时返回空对象', () => {
		const mgr = useBotConnections();
		expect(mgr.getStates()).toEqual({});
	});

	test('断开连接后不再出现在 getStates() 中', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnect('bot-1');
		expect(mgr.getStates()).toEqual({ 'bot-2': 'connecting' });
	});
});

describe('size', () => {
	test('初始为 0', () => {
		expect(useBotConnections().size).toBe(0);
	});

	test('随连接增加', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		expect(mgr.size).toBe(2);
	});

	test('随断开减少', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnect('bot-1');
		expect(mgr.size).toBe(1);
	});

	test('disconnectAll 后归零', () => {
		const mgr = useBotConnections();
		mgr.connect('bot-1');
		mgr.connect('bot-2');
		mgr.disconnectAll();
		expect(mgr.size).toBe(0);
	});
});
