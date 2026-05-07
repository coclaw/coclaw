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

test('createRpcDropMonitor: 精确返回 6 个方法（pin 数量，防 API 加项时漏改测试）', () => {
	const { monitor } = makeMonitor();
	const keys = Object.keys(monitor);
	assert.equal(keys.length, 6, `expected exactly 6 methods, got ${keys.length}: ${keys.join(',')}`);
	assert.equal(typeof monitor.onDrop, 'function');
	assert.equal(typeof monitor.onSpillStart, 'function');
	assert.equal(typeof monitor.onSpillEnd, 'function');
	assert.equal(typeof monitor.maybeEmitOverflowEnd, 'function');
	assert.equal(typeof monitor.summarize, 'function');
	assert.equal(typeof monitor.getStats, 'function');
});

test('getStats 初始: dropCount=0, dropBytes=0, overflowActive=false, spillActive=false, fsBroken=false, lastReason=null', () => {
	const { monitor } = makeMonitor();
	const s = monitor.getStats();
	assert.deepEqual(s, {
		dropCount: 0,
		dropBytes: 0,
		overflowActive: false,
		spillActive: false,
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

test('onDrop oversize: 每次独立 warn 含 conn+size，不改 overflowActive', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connOv' });
	const size1 = 70 * 1024 * 1024;
	const size2 = 80 * 1024 * 1024;
	monitor.onDrop('oversize', size1);
	monitor.onDrop('oversize', size2);
	const s = monitor.getStats();
	assert.equal(s.overflowActive, false);
	assert.equal(s.dropCount, 2);
	assert.equal(s.dropBytes, size1 + size2);
	assert.equal(s.lastReason, 'oversize');
	const overWarns = logger.warnings.filter(w => w.includes('oversize'));
	assert.equal(overWarns.length, 2, 'oversize warn fires per call');
	assert.ok(overWarns.every(w => w.includes('conn=connOv')));
	assert.ok(overWarns[0].includes(`size=${size1}`));
	assert.ok(overWarns[1].includes(`size=${size2}`));
});

// --- onDrop: fs-error ---

test('onDrop fs-error 首次: fsBroken=true + warn/remoteLog 含 conn+errno+msg', () => {
	const { monitor, logger } = makeMonitor({ connId: 'connFs' });
	monitor.onDrop('fs-error', 512, { code: 'ENOSPC', message: 'no space left on device' });
	const s = monitor.getStats();
	assert.equal(s.fsBroken, true);
	assert.equal(s.dropCount, 1);
	const fsWarns = logger.warnings.filter(w => w.includes('fs-broken'));
	assert.equal(fsWarns.length, 1);
	assert.ok(fsWarns[0].includes('conn=connFs'));
	assert.ok(fsWarns[0].includes('errno=ENOSPC'));
	assert.ok(fsWarns[0].includes('no space left on device'));
	const rl = remoteLogBuffer.find(e => e.text.includes('rpc-queue.fs-broken'));
	assert.ok(rl);
	assert.match(rl.text, /conn=connFs/);
	assert.match(rl.text, /errno=ENOSPC/);
	assert.match(rl.text, /no space left on device/);
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

test('onDrop disk-cap 首次: overflowActive=true + warn/remoteLog 含 conn+size（与 queue-full 边沿对称）', () => {
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
	assert.ok(startWarns[0].includes('conn=connDC'));
	assert.ok(startWarns[0].includes('size=4096'));
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
	monitor.summarize({ memCount: 3, memBytes: 700, diskBytes: 0, writtenBytes: 0 });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	const t = closes[0].text;
	assert.match(t, /conn=connClose/);
	assert.match(t, /dropped=2/);
	assert.match(t, /droppedBytes=1536/);
	assert.match(t, /residualChunks=3/);
	assert.match(t, /residualBytes=700/);
	assert.match(t, /residualDiskBytes=0/);
	assert.match(t, /residualWrittenBytes=0/);
	assert.match(t, /fsBroken=false/);
	assert.match(t, /spillActive=false/);
	assert.match(t, /lastReason=queue-full/);
	// 幂等
	monitor.summarize({ memCount: 99, memBytes: 9999 });
	const closes2 = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes2.length, 1, 'second summarize is no-op');
});

test('summarize: 本地 log 镜像 close 与 remoteLog 同字段（开发者主要看本地 log）', () => {
	// close 信号同时走 logger.warn（本地）+ remoteLog（server）。本地用 tagged 格式 `[rpc-queue conn=X] close ...`，
	// remote 用 dotted 格式 `rpc-queue.close conn=X ...`，字段顺序与值完全一致便于对齐 grep。
	const { monitor, logger } = makeMonitor({ connId: 'connLocalMirror' });
	monitor.onDrop('queue-full', 2048);
	monitor.summarize({ memCount: 1, memBytes: 100, diskBytes: 200, writtenBytes: 300 });
	const localCloses = logger.warnings.filter(w => w.includes('] close '));
	assert.equal(localCloses.length, 1, '本地 log 应 emit 一次');
	const t = localCloses[0];
	assert.match(t, /\[rpc-queue conn=connLocalMirror\] close /);
	assert.match(t, /dropped=1 droppedBytes=2048/);
	assert.match(t, /residualChunks=1 residualBytes=100/);
	assert.match(t, /residualDiskBytes=200 residualWrittenBytes=300/);
	assert.match(t, /fsBroken=false spillActive=false/);
	assert.match(t, /lastReason=queue-full/);
	// 幂等：第二次 summarize 不再发本地 log
	monitor.summarize();
	assert.equal(logger.warnings.filter(w => w.includes('] close ')).length, 1, 'second summarize 不重复 emit 本地');
});

test('summarize: 干净状态不发本地 log（anomaly-only，与 remoteLog 同步）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.summarize();
	assert.equal(logger.warnings.filter(w => w.includes('] close ')).length, 0);
});

test('summarize: dropCount>0 但 overflowActive=false（仅 oversize drop）→ 仍 emit', () => {
	// 单独验"dropCount>0"分支不被 overflowActive 短路（C-1）
	const { monitor } = makeMonitor({ connId: 'connOnlyDrops' });
	monitor.onDrop('oversize', 70 * 1024 * 1024);
	monitor.onDrop('oversize', 80 * 1024 * 1024);
	assert.equal(monitor.getStats().overflowActive, false, 'oversize 不改 overflowActive');
	assert.ok(monitor.getStats().dropCount > 0);
	monitor.summarize();
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /dropped=2/);
	assert.match(closes[0].text, /lastReason=oversize/);
});

test('summarize(residual diskBytes>0): 即使无 mem 残留也 emit（FBQ 阶段诊断完整性，D-2 修复）', () => {
	const { monitor } = makeMonitor({ connId: 'connDisk' });
	monitor.summarize({ memCount: 0, memBytes: 0, diskBytes: 4096, writtenBytes: 0 });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /residualDiskBytes=4096/);
	assert.match(closes[0].text, /residualWrittenBytes=0/);
	assert.match(closes[0].text, /residualChunks=0/);
});

test('summarize(residual writtenBytes>0): 即使无其它残留也 emit', () => {
	const { monitor } = makeMonitor();
	monitor.summarize({ memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 8192 });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /residualWrittenBytes=8192/);
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
	assert.match(closes[0].text, /residualDiskBytes=0/);
	assert.match(closes[0].text, /residualWrittenBytes=0/);
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

test('summarize(residual.fsBroken=true): onDrop 从未触发 fs-error 也应 emit close 含 fsBroken=true（FBQ bypass-overshoot 场景兜底）', () => {
	// FBQ 真坏的几条路径（writeStream emit error 异步 / refill stat err / 全程仅 bypass 命中走 mem-overshoot）
	// 可让 queue.fsBroken=true 但 monitor 永不收 onDrop('fs-error')。close 时透 residualStats.fsBroken
	// 让运维侧仍能在 close 日志看到队列降级了。
	const { monitor } = makeMonitor({ connId: 'connSilentFsBroken' });
	// 注意：此 monitor 全程未触发 fs-error onDrop，内部 fsBroken 标量保持 false
	assert.equal(monitor.getStats().fsBroken, false);
	monitor.summarize({ memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 0, fsBroken: true });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1);
	assert.match(closes[0].text, /fsBroken=true/);
	assert.match(closes[0].text, /conn=connSilentFsBroken/);
});

test('summarize: spillActive=true 单独触发 anomaly close（spill 文件没 drain 完就 close）', () => {
	// FBQ 物理文件创建后 onSpillStart 已 fire，未 drain 完就 destroy（onSpillEnd 不调）。
	// 通常 residualWrittenBytes/residualDiskBytes>0 也会触发 anomaly，但本用例验证 spillActive
	// 单独纳入 anomaly 信号——避免日后 stats 路径漂移让"以 spill 状态结束"静默。
	const { monitor } = makeMonitor({ connId: 'connSpillEnd' });
	monitor.onSpillStart();
	assert.equal(monitor.getStats().spillActive, true);
	resetRemoteLog(); // 清掉 spill-start 单独验 close
	monitor.summarize();
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1, 'spillActive=true 应触发 anomaly close');
	assert.match(closes[0].text, /spillActive=true/);
	assert.match(closes[0].text, /conn=connSpillEnd/);
});

test('summarize: 仅 spill-start 触发后立即 spill-end → spillActive=false → 干净状态不 emit', () => {
	// 反向 invariant：完整 spill 周期（spill-start → spill-end）后 spillActive 复位，
	// 干净 summarize 不应仅因"曾经 spill 过"就 emit。
	const { monitor } = makeMonitor();
	monitor.onSpillStart();
	monitor.onSpillEnd(1000);
	assert.equal(monitor.getStats().spillActive, false);
	resetRemoteLog();
	monitor.summarize();
	assert.equal(remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close')).length, 0);
});

test('overflow + spill 同时 active：两 flag 完全独立，互不影响（getStats 同时返回 true）', () => {
	// 两条边沿状态机的独立性 invariant pin：queue-full/disk-cap 走 overflowActive，
	// spill-start/spill-end 走 spillActive。两边逻辑分离，状态翻转不互相干扰。
	const { monitor } = makeMonitor();
	// 先触发 overflow（queue-full 边沿）
	monitor.onDrop('queue-full', 1024);
	assert.equal(monitor.getStats().overflowActive, true);
	assert.equal(monitor.getStats().spillActive, false);
	// 叠加 spill-start
	monitor.onSpillStart();
	assert.equal(monitor.getStats().overflowActive, true, 'spill-start 不应碰 overflowActive');
	assert.equal(monitor.getStats().spillActive, true);
	// spill-end 单方面复位 spillActive，不动 overflowActive
	monitor.onSpillEnd(2048);
	assert.equal(monitor.getStats().overflowActive, true, 'spill-end 不应碰 overflowActive');
	assert.equal(monitor.getStats().spillActive, false);
	// overflow-end 单方面复位 overflowActive
	monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 });
	assert.equal(monitor.getStats().overflowActive, false);
	assert.equal(monitor.getStats().spillActive, false);
});

test('summarize: residual.fsBroken=true + onDrop 已触发 fs-error → 仅 emit 一次 close 含 fsBroken=true（双源同源不重复）', () => {
	// 现实场景：onDrop('fs-error') 已让 monitor 内部 fsBroken=true；queue.stats() 也会回 fsBroken=true。
	// summarize 同时拿到两个来源（都为 true），应只发一次 close，且 fsBroken 字段为 true（不重复 emit）。
	const { monitor } = makeMonitor({ connId: 'connBothFsBroken' });
	monitor.onDrop('fs-error', 256, { code: 'ENOSPC', message: 'disk full' });
	assert.equal(monitor.getStats().fsBroken, true);
	monitor.summarize({ memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 0, fsBroken: true });
	const closes = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.close'));
	assert.equal(closes.length, 1, 'close 仅发一次');
	assert.match(closes[0].text, /fsBroken=true/);
	assert.match(closes[0].text, /conn=connBothFsBroken/);
});

// --- 防御性包装 ---

test('logger.warn 抛: onDrop 不传染（queue-full 边沿）+ 验证 warn 真的被调', () => {
	let warnCalls = 0;
	const throwingLogger = {
		warn: () => { warnCalls += 1; throw new Error('logger boom'); },
		info: () => {},
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	assert.doesNotThrow(() => monitor.onDrop('queue-full', 100));
	assert.equal(warnCalls, 1, 'logger.warn 必须被调一次');
	assert.equal(monitor.getStats().overflowActive, true);
	assert.equal(monitor.getStats().dropCount, 1);
});

test('logger.warn 抛: onDrop oversize 不传染 + 验证 warn 被调', () => {
	let warnCalls = 0;
	const throwingLogger = {
		warn: () => { warnCalls += 1; throw new Error('boom'); },
		info: () => {},
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	assert.doesNotThrow(() => monitor.onDrop('oversize', 100));
	assert.equal(warnCalls, 1);
	assert.equal(monitor.getStats().dropCount, 1);
});

test('logger.info 抛: maybeEmitOverflowEnd 不传染 + 验证 info 被调', () => {
	let infoCalls = 0;
	const throwingLogger = {
		warn: () => {},
		info: () => { infoCalls += 1; throw new Error('boom'); },
		error: () => {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	monitor.onDrop('queue-full', 10);
	assert.doesNotThrow(() => {
		monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 });
	});
	assert.equal(infoCalls, 1, 'logger.info 必须被调一次');
	assert.equal(monitor.getStats().overflowActive, false, 'state still flips even if logger throws');
});

test('maybeEmitOverflowEnd: stats=null/undefined 安全跳过（防御性，无未捕获 TypeError）', () => {
	const { monitor } = makeMonitor();
	monitor.onDrop('queue-full', 100);
	assert.doesNotThrow(() => monitor.maybeEmitOverflowEnd(null));
	assert.doesNotThrow(() => monitor.maybeEmitOverflowEnd(undefined));
	// 仍处于 active（未翻转）
	assert.equal(monitor.getStats().overflowActive, true);
});

// --- logger 缺方法防御 ---

test('多实例独立：不同 connId 各自累计 / log / summarize 完全隔离（移动端 5-8 并发 DC 场景）', () => {
	// 真实生产环境：移动端同时持有多条 rpc DC（5-8 个并发），各自独立的 monitor
	// 实例不能 cross-pollute 计数 / 日志 / summarize 结果——闭包工厂模型应天然支持
	resetRemoteLog();
	const lgA = makeMockLogger();
	const lgB = makeMockLogger();
	const lgC = makeMockLogger();
	const mA = createRpcDropMonitor({ connId: 'CONN-A', logger: lgA });
	const mB = createRpcDropMonitor({ connId: 'CONN-B', logger: lgB });
	const mC = createRpcDropMonitor({ connId: 'CONN-C', logger: lgC });

	// 三个 monitor 各自独立 onDrop 不同 reason / size：
	// A: queue-full ×1 + oversize ×1
	// B: queue-full ×2（持续期，仅首次 log）
	// C: fs-error ×1
	mA.onDrop('queue-full', 100);
	mB.onDrop('queue-full', 200);
	mB.onDrop('queue-full', 300);
	mC.onDrop('fs-error', 50, { code: 'ENOSPC' });
	mA.onDrop('oversize', 30);

	// 计数独立
	const sA = mA.getStats();
	const sB = mB.getStats();
	const sC = mC.getStats();
	assert.equal(sA.dropCount, 2);
	assert.equal(sA.dropBytes, 130);
	assert.equal(sA.fsBroken, false);
	assert.equal(sB.dropCount, 2);
	assert.equal(sB.dropBytes, 500);
	assert.equal(sB.fsBroken, false);
	assert.equal(sC.dropCount, 1);
	assert.equal(sC.dropBytes, 50);
	assert.equal(sC.fsBroken, true);

	// log 输出按 connId 区分；不互相串
	for (const w of lgA.warnings) assert.match(w, /conn=CONN-A/);
	for (const w of lgB.warnings) assert.match(w, /conn=CONN-B/);
	for (const w of lgC.warnings) assert.match(w, /conn=CONN-C/);
	assert.equal(lgA.warnings.some((w) => /CONN-(B|C)/.test(w)), false);
	assert.equal(lgB.warnings.some((w) => /CONN-(A|C)/.test(w)), false);
	assert.equal(lgC.warnings.some((w) => /CONN-(A|B)/.test(w)), false);

	// remoteLog 中三条 connId 都应出现，互不污染
	const aLogs = remoteLogBuffer.filter((e) => e.text.includes('conn=CONN-A'));
	const bLogs = remoteLogBuffer.filter((e) => e.text.includes('conn=CONN-B'));
	const cLogs = remoteLogBuffer.filter((e) => e.text.includes('conn=CONN-C'));
	assert.ok(aLogs.length >= 1);
	assert.ok(bLogs.length >= 1);
	assert.ok(cLogs.length >= 1);

	// summarize 独立 emit；各自带自己的 connId / dropCount / dropBytes
	const cleanResidual = { memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 0, spilled: false, fsBroken: false };
	mA.summarize(cleanResidual);
	mB.summarize(cleanResidual);
	mC.summarize(cleanResidual);

	const closeLogs = remoteLogBuffer.filter((e) => e.text.includes('rpc-queue.close'));
	assert.equal(closeLogs.length, 3, 'three monitors should each emit a distinct close summary');
	const closeA = closeLogs.find((e) => e.text.includes('conn=CONN-A'));
	const closeB = closeLogs.find((e) => e.text.includes('conn=CONN-B'));
	const closeC = closeLogs.find((e) => e.text.includes('conn=CONN-C'));
	assert.ok(closeA && closeB && closeC, 'each connId should have its own close summary');
	assert.match(closeA.text, /dropped=2 droppedBytes=130/);
	assert.match(closeB.text, /dropped=2 droppedBytes=500/);
	assert.match(closeC.text, /dropped=1 droppedBytes=50/);
});

test('logger 缺 warn / info: onDrop / maybeEmitOverflowEnd 不抛', () => {
	const partialLogger = {};
	const { monitor } = makeMonitor({ logger: partialLogger });
	assert.doesNotThrow(() => monitor.onDrop('queue-full', 100));
	assert.doesNotThrow(() => monitor.onDrop('oversize', 200));
	assert.doesNotThrow(() => monitor.onDrop('fs-error', 300, { code: 'ENOSPC' }));
	assert.doesNotThrow(() => monitor.maybeEmitOverflowEnd({ memCount: 0, memBytes: 0, writtenBytes: 0 }));
	assert.doesNotThrow(() => monitor.onSpillStart());
	assert.doesNotThrow(() => monitor.onSpillEnd(1024));
});

// --- onSpillStart / onSpillEnd ---

test('onSpillStart: 边沿触发，info + remoteLog 各发一次；重复调用幂等', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onSpillStart();
	monitor.onSpillStart(); // 幂等：已 active 时跳过
	const startInfos = logger.infos.filter(m => m.includes('spill-start'));
	assert.equal(startInfos.length, 1);
	assert.match(startInfos[0], /\[rpc-queue conn=C1\] spill-start/);
	const startRemote = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.spill-start'));
	assert.equal(startRemote.length, 1);
	assert.equal(startRemote[0].text, 'rpc-queue.spill-start conn=C1');
	assert.equal(monitor.getStats().spillActive, true);
});

test('onSpillEnd: 边沿触发，drainedBytes 出现在 info + remoteLog；未 active 时静默', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onSpillEnd(1234); // 未 active：no-op
	assert.equal(logger.infos.filter(m => m.includes('spill-end')).length, 0);
	assert.equal(remoteLogBuffer.filter(e => e.text.includes('spill-end')).length, 0);

	monitor.onSpillStart();
	monitor.onSpillEnd(2048);
	monitor.onSpillEnd(9999); // 幂等：已非 active
	const endInfos = logger.infos.filter(m => m.includes('spill-end'));
	assert.equal(endInfos.length, 1);
	assert.match(endInfos[0], /spill-end drainedBytes=2048/);
	const endRemote = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.spill-end'));
	assert.equal(endRemote.length, 1);
	assert.equal(endRemote[0].text, 'rpc-queue.spill-end conn=C1 drainedBytes=2048');
	assert.equal(monitor.getStats().spillActive, false);
});

test('onSpillStart / onSpillEnd 多轮翻转：每对边沿都 emit', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onSpillStart();
	monitor.onSpillEnd(100);
	monitor.onSpillStart();
	monitor.onSpillEnd(200);
	const startCount = logger.infos.filter(m => m.includes('spill-start')).length;
	const endCount = logger.infos.filter(m => m.includes('spill-end')).length;
	assert.equal(startCount, 2);
	assert.equal(endCount, 2);
	const ends = logger.infos.filter(m => m.includes('spill-end'));
	assert.match(ends[0], /drainedBytes=100/);
	assert.match(ends[1], /drainedBytes=200/);
});

test('logger.info 抛: onSpillStart / onSpillEnd 不传染，状态仍正确翻转', () => {
	// 紧化断言：仅"不抛"会被 no-op handler 同等满足；这里要求 spillActive 在 throw 后仍正确翻转，
	// 防止"日志失败也连带状态机失败"的回归。
	const throwingLogger = {
		warn() {},
		info() { throw new Error('logger info bug'); },
		error() {},
	};
	const { monitor } = makeMonitor({ logger: throwingLogger });
	assert.doesNotThrow(() => monitor.onSpillStart());
	assert.equal(monitor.getStats().spillActive, true, 'spillActive 应该翻转，即使 logger 抛错');
	assert.doesNotThrow(() => monitor.onSpillEnd(500));
	assert.equal(monitor.getStats().spillActive, false, 'spillActive 应该复位，即使 logger 抛错');
});

// --- disk-cap-start 分量展开 ---

test('onDrop disk-cap: 第三参带 memBytes/writtenBytes/diskCap 时展开到 log', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('disk-cap', 100, { memBytes: 50, writtenBytes: 200, diskCap: 256 });
	const startWarn = logger.warnings.find(m => m.includes('disk-cap-start'));
	assert.match(startWarn, /size=100 memBytes=50 writtenBytes=200 diskCap=256/);
	const startRemote = remoteLogBuffer.find(e => e.text.includes('rpc-queue.disk-cap-start'));
	assert.equal(
		startRemote.text,
		'rpc-queue.disk-cap-start conn=C1 size=100 memBytes=50 writtenBytes=200 diskCap=256',
	);
});

test('onDrop disk-cap: 第三参缺失时分量降为 0（向后兼容）', () => {
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('disk-cap', 50); // 未传第三参（FBQ 早期版本兼容路径）
	const startWarn = logger.warnings.find(m => m.includes('disk-cap-start'));
	assert.match(startWarn, /size=50 memBytes=0 writtenBytes=0 diskCap=0/);
});

test('onDrop disk-cap: 第三参部分字段缺失时仅缺失分量降为 0', () => {
	// 单独 pin 每个 ?? 0 fallback：仅 memBytes 提供时 writtenBytes / diskCap 各自降为 0、不污染已提供字段
	const { monitor, logger } = makeMonitor();
	monitor.onDrop('disk-cap', 50, { memBytes: 77 });
	const startWarn = logger.warnings.find(m => m.includes('disk-cap-start'));
	assert.match(startWarn, /size=50 memBytes=77 writtenBytes=0 diskCap=0/);
});
