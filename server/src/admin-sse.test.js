import assert from 'node:assert/strict';
import test from 'node:test';

import { clawStatusEmitter } from './claw-ws-hub.js';
import {
	hasAdminSseClients,
	registerAdminSseClient,
	__test,
} from './admin-sse.js';

const { handleStatusEvent, handleInfoUpdatedEvent, broadcast, adminSseClients } = __test;

function createMockRes() {
	const written = [];
	const closeHandlers = [];
	return {
		written,
		write(data) { written.push(data); },
		on(event, handler) {
			if (event === 'close') closeHandlers.push(handler);
		},
		__triggerClose() {
			for (const h of closeHandlers) h();
		},
	};
}

function drain() {
	// 清除跨测试残留
	for (const res of [...adminSseClients]) {
		if (typeof res.__triggerClose === 'function') {
			res.__triggerClose();
		}
		adminSseClients.delete(res);
	}
}

test('hasAdminSseClients: 无客户端时返回 false', () => {
	drain();
	assert.equal(hasAdminSseClients(), false);
});

test('registerAdminSseClient: 连接即推 snapshot 且加入集合', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, {
		listOnlineClawIdsImpl: () => new Set(['10', '20']),
	});

	assert.equal(res.written.length, 1);
	const parsed = JSON.parse(res.written[0].replace('data: ', '').trim());
	assert.equal(parsed.event, 'snapshot');
	assert.deepEqual(parsed.onlineClawIds.sort(), ['10', '20']);
	assert.equal(hasAdminSseClients(), true);

	res.__triggerClose();
	assert.equal(hasAdminSseClients(), false);
});

test('registerAdminSseClient: snapshot write 抛异常时静默捕获并仍加入集合', () => {
	drain();
	let writeAttempt = 0;
	const res = {
		write() {
			writeAttempt++;
			if (writeAttempt === 1) throw new Error('broken pipe');
		},
		on() {},
	};

	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set(['1']) });

	assert.equal(hasAdminSseClients(), true);
	adminSseClients.delete(res);
});

test('registerAdminSseClient: 使用默认 listOnlineClawIds 分支', () => {
	drain();
	const res = createMockRes();
	// 不传 listOnlineClawIdsImpl，走默认依赖
	registerAdminSseClient(res);
	assert.equal(res.written.length, 1);
	const parsed = JSON.parse(res.written[0].replace('data: ', '').trim());
	assert.equal(parsed.event, 'snapshot');
	assert.ok(Array.isArray(parsed.onlineClawIds));
	res.__triggerClose();
});

test('handleStatusEvent: 向所有客户端广播 claw.statusChanged', () => {
	drain();
	const r1 = createMockRes();
	const r2 = createMockRes();
	registerAdminSseClient(r1, { listOnlineClawIdsImpl: () => new Set() });
	registerAdminSseClient(r2, { listOnlineClawIdsImpl: () => new Set() });

	handleStatusEvent({ clawId: '5', online: true });

	const evt1 = JSON.parse(r1.written[1].replace('data: ', '').trim());
	const evt2 = JSON.parse(r2.written[1].replace('data: ', '').trim());
	assert.equal(evt1.event, 'claw.statusChanged');
	assert.equal(evt1.clawId, '5');
	assert.equal(evt1.online, true);
	assert.deepEqual(evt1, evt2);

	r1.__triggerClose();
	r2.__triggerClose();
});

test('handleInfoUpdatedEvent: 全字段 patch 时广播全部字段', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });

	handleInfoUpdatedEvent({
		clawId: '7',
		name: 'my',
		hostName: 'ubuntu',
		pluginVersion: '0.14.0',
		agentModels: [{ id: 'main', name: 'Main', model: 'opus' }],
	});

	const evt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(evt.event, 'claw.infoUpdated');
	assert.equal(evt.clawId, '7');
	assert.equal(evt.name, 'my');
	assert.equal(evt.hostName, 'ubuntu');
	assert.equal(evt.pluginVersion, '0.14.0');
	assert.deepEqual(evt.agentModels, [{ id: 'main', name: 'Main', model: 'opus' }]);

	res.__triggerClose();
});

test('handleInfoUpdatedEvent: 部分字段 patch（仅 name+hostName）时 wire 不包含未提供字段', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });

	handleInfoUpdatedEvent({
		clawId: '8',
		name: 'renamed',
		hostName: 'ubuntu',
	});

	const evt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(evt.event, 'claw.infoUpdated');
	assert.equal(evt.clawId, '8');
	assert.equal(evt.name, 'renamed');
	assert.equal(evt.hostName, 'ubuntu');
	assert.equal('pluginVersion' in evt, false, 'wire 不应包含未提供字段');
	assert.equal('agentModels' in evt, false);

	res.__triggerClose();
});

test('handleInfoUpdatedEvent: 仅 agentModels patch 时 wire 仅含 clawId + agentModels', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });

	handleInfoUpdatedEvent({
		clawId: '9',
		agentModels: [],
	});

	const evt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(evt.event, 'claw.infoUpdated');
	assert.equal(evt.clawId, '9');
	assert.deepEqual(evt.agentModels, []);
	assert.equal('name' in evt, false);
	assert.equal('hostName' in evt, false);
	assert.equal('pluginVersion' in evt, false);

	res.__triggerClose();
});

test('handleInfoUpdatedEvent: 显式 null 字段（patch 中存在但值为 null）应被透传', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });

	handleInfoUpdatedEvent({
		clawId: '10',
		name: null,
		hostName: null,
	});

	const evt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(evt.name, null);
	assert.equal(evt.hostName, null);

	res.__triggerClose();
});

test('broadcast: 无客户端时为 no-op', () => {
	drain();
	// 不应抛异常
	broadcast({ event: 'x' });
});

test('broadcast: write 抛异常时静默捕获', () => {
	drain();
	const bad = { write() { throw new Error('pipe'); }, on() {} };
	const good = createMockRes();
	adminSseClients.add(bad);
	registerAdminSseClient(good, { listOnlineClawIdsImpl: () => new Set() });

	broadcast({ event: 'ping' });

	// good 应收到（snapshot + ping = 2 条）
	assert.equal(good.written.length, 2);
	adminSseClients.delete(bad);
	good.__triggerClose();
});

test('clawStatusEmitter status/infoUpdated 触发时转发到 admin-sse', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });

	clawStatusEmitter.emit('status', { clawId: '99', online: false });
	clawStatusEmitter.emit('infoUpdated', {
		clawId: '99',
		name: 'x',
		hostName: 'h',
		pluginVersion: 'v',
		agentModels: null,
	});

	// snapshot + status + infoUpdated = 3 条
	assert.equal(res.written.length, 3);
	const status = JSON.parse(res.written[1].replace('data: ', '').trim());
	const info = JSON.parse(res.written[2].replace('data: ', '').trim());
	assert.equal(status.event, 'claw.statusChanged');
	assert.equal(info.event, 'claw.infoUpdated');
	assert.equal(info.agentModels, null);

	res.__triggerClose();
});

test('registerAdminSseClient: close 清理后广播不再命中', () => {
	drain();
	const res = createMockRes();
	registerAdminSseClient(res, { listOnlineClawIdsImpl: () => new Set() });
	res.__triggerClose();

	handleStatusEvent({ clawId: '1', online: true });

	assert.equal(res.written.length, 1); // 只有最初的 snapshot
});
