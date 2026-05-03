import test from 'node:test';
import assert from 'node:assert/strict';

import { createRpcDropMonitor } from './rpc-drop-monitor.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

// --- helpers ---

function makeMockLogger() {
	const warnings = [];
	const infos = [];
	return {
		warnings,
		infos,
		info(msg) { infos.push(String(msg)); },
		warn(msg) { warnings.push(String(msg)); },
		error() {},
		debug() {},
	};
}

function makeMonitor(opts = {}) {
	resetRemoteLog();
	const logger = opts.logger ?? makeMockLogger();
	const monitor = createRpcDropMonitor({
		connId: opts.connId ?? 'C1',
		logger,
	});
	return { monitor, logger };
}

// --- 工厂返回的 API 形态 ---

test('createRpcDropMonitor: 返回 4 个方法', () => {
	const { monitor } = makeMonitor();
	assert.equal(typeof monitor.onDrop, 'function');
	assert.equal(typeof monitor.maybeEmitOverflowEnd, 'function');
	assert.equal(typeof monitor.summarize, 'function');
	assert.equal(typeof monitor.getStats, 'function');
});

test('getStats 初始: dropCount=0, dropBytes=0, overflowActive=false, fsBroken=false, lastReason=null', () => {
	const { monitor } = makeMonitor();
	const s = monitor.getStats();
	assert.deepEqual(s, {
		dropCount: 0,
		dropBytes: 0,
		overflowActive: false,
		fsBroken: false,
		lastReason: null,
	});
});

test('getStats: 返回新对象，修改不污染内部', () => {
	const { monitor } = makeMonitor();
	const s1 = monitor.getStats();
	s1.dropCount = 999;
	s1.fsBroken = true;
	const s2 = monitor.getStats();
	assert.equal(s2.dropCount, 0);
	assert.equal(s2.fsBroken, false);
	// 不同对象引用
	assert.notStrictEqual(s1, s2);
});

// --- onDrop: queue-full 边沿 ---

test('onDrop queue-full 首次: overflowActive=true + warn + remoteLog 含 conn/size', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connA' });
	monitor.onDrop('queue-full', 1234);
	const s = monitor.getStats();
	assert.equal(s.overflowActive, true);
	assert.equal(s.dropCount, 1);
	assert.equal(s.dropBytes, 1234);
	assert.equal(s.lastReason, 'queue-full');
	assert.ok(logger.warnings.some(w => w.includes('overflow-start') && w.includes('conn=connA') && w.includes('queueBytes=1234')));
	const rl = remoteLogBuffer.find(e => e.text.includes('rpc-queue.overflow-start'));
	assert.ok(rl, 'expect remoteLog overflow-start');
	assert.match(rl.text, /conn=connA/);
	assert.match(rl.text, /queueBytes=1234/);
});

test('onDrop queue-full 重复: 计数器累加，仅首次 log（持续期间静默）', () => {
	const { monitor, logger } = makeMonitor();
	for (let i = 0; i < 10; i += 1) monitor.onDrop('queue-full', 100);
	const s = monitor.getStats();
	assert.equal(s.dropCount, 10);
	assert.equal(s.dropBytes, 1000);
	const startWarns = logger.warnings.filter(w => w.includes('overflow-start'));
	assert.equal(startWarns.length, 1, 'overflow-start warn fires once');
	const startRemote = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start'));
	assert.equal(startRemote.length, 1);
});

// --- onDrop: oversize ---

test('onDrop oversize: 每次独立 warn，不改 overflowActive', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connOv' });
	monitor.onDrop('oversize', 70 * 1024 * 1024);
	monitor.onDrop('oversize', 80 * 1024 * 1024);
	const s = monitor.getStats();
	assert.equal(s.overflowActive, false);
	assert.equal(s.dropCount, 2);
	assert.equal(s.dropBytes, 70 * 1024 * 1024 + 80 * 1024 * 1024);
	assert.equal(s.lastReason, 'oversize');
	const overWarns = logger.warnings.filter(w => w.includes('oversize'));
	assert.equal(overWarns.length, 2, 'oversize warn fires per call');
	assert.ok(overWarns.every(w => w.includes('conn=connOv')));
});

// --- onDrop: fs-error ---

test('onDrop fs-error 首次: fsBroken=true + warn 含 errno（来自 err.code）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('fs-error', 512, { code: 'ENOSPC', message: 'no space left on device' });
	const s = monitor.getStats();
	assert.equal(s.fsBroken, true);
	assert.equal(s.dropCount, 1);
	const fsWarns = logger.warnings.filter(w => w.includes('fs-broken'));
	assert.equal(fsWarns.length, 1);
	assert.ok(fsWarns[0].includes('errno=ENOSPC'));
	assert.ok(fsWarns[0].includes('no space left on device'));
	const rl = remoteLogBuffer.find(e => e.text.includes('rpc-queue.fs-broken'));
	assert.ok(rl);
	assert.match(rl.text, /errno=ENOSPC/);
});

test('onDrop fs-error 无 err 参: errno=UNKNOWN', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('fs-error', 100);
	const fsWarns = logger.warnings.filter(w => w.includes('fs-broken'));
	assert.equal(fsWarns.length, 1);
	assert.ok(fsWarns[0].includes('errno=UNKNOWN'));
});

test('onDrop fs-error 重复: fsBroken 维持 true，仅首次 log（sticky）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('fs-error', 100, { code: 'EROFS' });
	monitor.onDrop('fs-error', 200, { code: 'ENOSPC' });
	monitor.onDrop('fs-error', 300, { code: 'EACCES' });
	const s = monitor.getStats();
	assert.equal(s.fsBroken, true);
	assert.equal(s.dropCount, 3);
	const fsWarns = logger.warnings.filter(w => w.includes('fs-broken'));
	assert.equal(fsWarns.length, 1, 'only first fs-error logs (sticky edge)');
	assert.ok(fsWarns[0].includes('errno=EROFS'));
});

// --- onDrop: disk-cap ---

test('onDrop disk-cap 首次: overflowActive=true + remoteLog（与 queue-full 边沿对称）', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connDC' });
	monitor.onDrop('disk-cap', 4096);
	const s = monitor.getStats();
	assert.equal(s.overflowActive, true);
	assert.equal(s.dropCount, 1);
	const startRemote = remoteLogBuffer.find(e => e.text.includes('rpc-queue.disk-cap-start'));
	assert.ok(startRemote, 'expect disk-cap-start remoteLog');
	assert.match(startRemote.text, /conn=connDC/);
	assert.match(startRemote.text, /size=4096/);
	const startWarns = logger.warnings.filter(w => w.includes('disk-cap-start'));
	assert.equal(startWarns.length, 1);
});

test('onDrop disk-cap 重复: overflowActive 维持，仅首次 log', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('disk-cap', 100);
	monitor.onDrop('disk-cap', 200);
	monitor.onDrop('disk-cap', 300);
	assert.equal(monitor.getStats().dropCount, 3);
	const startWarns = logger.warnings.filter(w => w.includes('disk-cap-start'));
	assert.equal(startWarns.length, 1);
});

test('onDrop unknown reason: 仅累加计数器，无 log', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('weird-reason', 50);
	const s = monitor.getStats();
	assert.equal(s.dropCount, 1);
	assert.equal(s.dropBytes, 50);
	assert.equal(s.lastReason, 'weird-reason');
	assert.equal(s.overflowActive, false);
	assert.equal(s.fsBroken, false);
	assert.equal(logger.warnings.length, 0);
	assert.equal(remoteLogBuffer.length, 0);
});

// --- maybeEmitOverflowEnd 防抖 ---

test('maybeEmitOverflowEnd: 排空 + active → emit end + 清 active；累计不重置', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connEnd' });
	monitor.onDrop('queue-full', 100);
	monitor.onDrop('queue-full', 200);
	assert.equal(monitor.getStats().overflowActive, true);
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 });
	const s = monitor.getStats();
	assert.equal(s.overflowActive, false);
	assert.equal(s.dropCount, 2, 'counters preserved cross-cycle');
	assert.equal(s.dropBytes, 300);
	const endInfos = logger.infos.filter(m => m.includes('overflow-end'));
	assert.equal(endInfos.length, 1);
	assert.ok(endInfos[0].includes('conn=connEnd'));
	assert.ok(endInfos[0].includes('dropped=2'));
	assert.ok(endInfos[0].includes('droppedBytes=300'));
	const endRemote = remoteLogBuffer.find(e => e.text.includes('rpc-queue.overflow-end'));
	assert.ok(endRemote);
	assert.match(endRemote.text, /dropped=2/);
	assert.match(endRemote.text, /droppedBytes=300/);
});

test('maybeEmitOverflowEnd: 未 active → no-op', () => {
	const { monitor, logger } = makeMonitor();
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 });
	assert.equal(logger.infos.length, 0);
	assert.equal(remoteLogBuffer.length, 0);
});

test('maybeEmitOverflowEnd: memCount>0 → 静默（防抖）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('queue-full', 100);
	monitor.maybeEmitOverflowEnd({ memCount: 5, memBytes: 500, writtenBytes: 0 });
	assert.equal(monitor.getStats().overflowActive, true, 'still active');
	const endInfos = logger.infos.filter(m => m.includes('overflow-end'));
	assert.equal(endInfos.length, 0);
});

test('maybeEmitOverflowEnd: writtenBytes>0 → 静默（候选 A 反抖动，B-stage2 才生效）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('queue-full', 100);
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 1024 });
	assert.equal(monitor.getStats().overflowActive, true, 'still active when disk has unwritten');
	assert.equal(logger.infos.filter(m => m.includes('overflow-end')).length, 0);
});

test('maybeEmitOverflowEnd: 状态机循环 start→end→start→end 双向可翻转', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('queue-full', 10); // start #1
	assert.equal(monitor.getStats().overflowActive, true);
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 }); // end #1
	assert.equal(monitor.getStats().overflowActive, false);
	monitor.onDrop('queue-full', 20); // start #2
	assert.equal(monitor.getStats().overflowActive, true);
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 }); // end #2
	assert.equal(monitor.getStats().overflowActive, false);
	const startCount = logger.warnings.filter(w => w.includes('overflow-start')).length;
	const endCount = logger.infos.filter(m => m.includes('overflow-end')).length;
	assert.equal(startCount, 2);
	assert.equal(endCount, 2);
	assert.equal(monitor.getStats().dropCount, 2);
	assert.equal(monitor.getStats().dropBytes, 30, 'counters accumulate cross-cycle');
});

// --- summarize ---

test('summarize(residual): dropCount>0 → emit close 含全部 token；幂等', () => {
	const { monitor } = makeMonitor({ connId: 'connClose' });
	monitor.onDrop('queue-full', 1024);
	monitor.onDrop('queue-full', 512);
	monitor.summarize({ memCount: 3, memBytes: 700 });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	const t = closes[0].text;
	assert.match(t, /conn=connClose/);
	assert.match(t, /dropped=2/);
	assert.match(t, /droppedBytes=1536/);
	assert.match(t, /residualChunks=3/);
	assert.match(t, /residualBytes=700/);
	assert.match(t, /fsBroken=false/);
	assert.match(t, /lastReason=queue-full/);
	// 幂等
	monitor.summarize({ memCount: 99, memBytes: 9999 });
	const closes2 = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes2.length, 1, 'second summarize is no-op');
});

test('summarize(): 干净状态（无 drop / 无 residual / 无 fsBroken）→ 不 emit', () => {
	const { monitor } = makeMonitor();
	monitor.summarize();
	assert.equal(remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close')).length, 0);
});

test('summarize(): 默认参数 residualStats=undefined 也可调', () => {
	const { monitor } = makeMonitor();
	monitor.onDrop('queue-full', 100);
	monitor.summarize();
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /residualChunks=0/);
	assert.match(closes[0].text, /residualBytes=0/);
});

test('summarize(residual): 仅有残留无 drop → 也 emit（残留是异常状态）', () => {
	const { monitor } = makeMonitor();
	monitor.summarize({ memCount: 5, memBytes: 100 });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /residualChunks=5/);
	assert.match(closes[0].text, /residualBytes=100/);
	assert.match(closes[0].text, /dropped=0/);
});

test('summarize(): 仅 fsBroken → emit', () => {
	const { monitor } = makeMonitor();
	monitor.onDrop('fs-error', 0, { code: 'ENOSPC' });
	resetRemoteLog(); // 清掉 fs-error remoteLog 单独验 close
	monitor.summarize();
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /fsBroken=true/);
	assert.match(closes[0].text, /lastReason=fs-error/);
});

// --- 防御性包装 ---

test('logger.warn 抛: onDrop 不传染（queue-full 边沿）', () => {
	const throwingLogger = {
		warn: () => { throw new Error('logger boom'); },
		info: () => {},
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	assert.doesNotThrow(() => monitor.onDrop('queue-full', 100));
	assert.equal(monitor.getStats().overflowActive, true);
	assert.equal(monitor.getStats().dropCount, 1);
});

test('logger.warn 抛: onDrop oversize 不传染', () => {
	const throwingLogger = {
		warn: () => { throw new Error('boom'); },
		info: () => {},
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	assert.doesNotThrow(() => monitor.onDrop('oversize', 100));
	assert.equal(monitor.getStats().dropCount, 1);
});

test('logger.info 抛: maybeEmitOverflowEnd 不传染', () => {
	const throwingLogger = {
		warn: () => {},
		info: () => { throw new Error('boom'); },
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	monitor.onDrop('queue-full', 10);
	assert.doesNotThrow(() => {
		monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 });
	});
	assert.equal(monitor.getStats().overflowActive, false, 'state still flips even if logger throws');
});

// --- logger 缺方法防御 ---

test('logger 缺 warn / info: onDrop / maybeEmitOverflowEnd 不抛', () => {
	const partialLogger = {};
	const { monitor } = makeMonitor({ logger: partialLogger });
	assert.doesNotThrow(() => monitor.onDrop('queue-full', 100));
	assert.doesNotThrow(() => monitor.onDrop('oversize', 200));
	assert.doesNotThrow(() => monitor.onDrop('fs-error', 300, { code: 'ENOSPC' }));
	assert.doesNotThrow(() => monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 }));
});
