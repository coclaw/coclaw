import test from 'node:test';
import assert from 'node:assert/strict';

import {
	RunEventRoutes,
	DEFAULT_TTL_MS,
	DEFAULT_SCAN_MS,
} from './run-event-routes.js';

// --- 测试辅助函数 ---

function makeLogger() {
	const warns = [];
	const infos = [];
	const debugs = [];
	const errors = [];
	return {
		warns,
		infos,
		debugs,
		errors,
		warn(msg) { warns.push(String(msg)); },
		info(msg) { infos.push(String(msg)); },
		debug(msg) { debugs.push(String(msg)); },
		error(msg) { errors.push(String(msg)); },
	};
}

/** 临时 monkey-patch global.setInterval / clearInterval。返回 captured intervals 数组 + 还原函数 */
function patchInterval() {
	const oldSet = global.setInterval;
	const oldClear = global.clearInterval;
	const captured = [];
	const cleared = [];
	global.setInterval = (fn, ms) => {
		const handle = { __fn: fn, __ms: ms, __unrefCount: 0, unref() { handle.__unrefCount += 1; } };
		captured.push(handle);
		return handle;
	};
	global.clearInterval = (handle) => {
		cleared.push(handle);
	};
	return {
		captured,
		cleared,
		restore() {
			global.setInterval = oldSet;
			global.clearInterval = oldClear;
		},
	};
}

/** 临时 monkey-patch Date.now，让测试不依赖真实时钟。返回 setNow + restore */
function patchDateNow(initial = 1_700_000_000_000) {
	const original = Date.now;
	let cur = initial;
	Date.now = () => cur;
	return {
		set(v) { cur = v; },
		advance(ms) { cur += ms; },
		now() { return cur; },
		restore() { Date.now = original; },
	};
}

// --- 构造与生命周期 ---

test('RunEventRoutes: 默认参数构造 logger=console、ttl/scan 默认值正确', () => {
	const routes = new RunEventRoutes();
	assert.equal(routes.logger, console);
	assert.equal(routes.ttlMs, DEFAULT_TTL_MS);
	assert.equal(routes.scanMs, DEFAULT_SCAN_MS);
	assert.equal(routes.__scanTimer, null);
	assert.equal(routes.__destroyed, false);
});

test('RunEventRoutes: 传 opts 但不传字段也走默认值', () => {
	const routes = new RunEventRoutes({});
	assert.equal(routes.logger, console);
	assert.equal(routes.ttlMs, DEFAULT_TTL_MS);
	assert.equal(routes.scanMs, DEFAULT_SCAN_MS);
});

test('RunEventRoutes: 自定义参数构造，构造期不起 timer', () => {
	const patch = patchInterval();
	try {
		const logger = makeLogger();
		const routes = new RunEventRoutes({ logger, ttlMs: 100, scanMs: 50 });
		assert.equal(routes.logger, logger);
		assert.equal(routes.ttlMs, 100);
		assert.equal(routes.scanMs, 50);
		assert.equal(patch.captured.length, 0, '构造函数纯组装，不应起 timer');
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: init 起 timer 且 ms 等于 scanMs，调用 unref', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes({ scanMs: 50 });
		routes.init();
		assert.equal(patch.captured.length, 1);
		assert.equal(patch.captured[0].__ms, 50);
		assert.equal(patch.captured[0].__unrefCount, 1);
		assert.equal(routes.__scanTimer, patch.captured[0]);
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: 重复 init 是 no-op，不堆 timer', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.init();
		routes.init();
		routes.init();
		assert.equal(patch.captured.length, 1);
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: destroy 停 timer + clear 表 + 标 __destroyed', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		const handle = patch.captured[0];
		routes.destroy();
		assert.equal(routes.__destroyed, true);
		assert.equal(routes.__scanTimer, null);
		assert.equal(routes.__entries.size, 0);
		assert.deepEqual(patch.cleared, [handle]);
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: destroy 幂等，多次调用安全', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.init();
		routes.destroy();
		routes.destroy();
		routes.destroy();
		assert.equal(patch.cleared.length, 1, 'clearInterval 仅应被调一次');
		assert.equal(routes.__destroyed, true);
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: 未 init 直接 destroy 安全（无 timer 也不抛）', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.destroy();
		assert.equal(patch.cleared.length, 0);
		assert.equal(routes.__destroyed, true);
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: destroy 后 add / remove / lookup / clear / init 全是 no-op', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		routes.destroy();

		// 调用都应静默不动（无新 timer、无写入、无读出、无抛错）
		routes.add('run-2', 'conn-B', 'req-2');
		assert.equal(routes.lookup('run-2'), undefined);

		routes.remove('run-1', 'req-1'); // 不抛
		routes.clear();                  // 不抛

		const initialIntervalCount = patch.captured.length;
		routes.init();
		assert.equal(patch.captured.length, initialIntervalCount, 'destroy 后 init 不应起新 timer');
	} finally {
		patch.restore();
	}
});

// --- 写入：add ---

test('RunEventRoutes: 正常 add 后 lookup 返回 connId', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	assert.equal(routes.lookup('run-1'), 'conn-A');
});

test('RunEventRoutes: add 缺 runId 静默返回', () => {
	const routes = new RunEventRoutes();
	routes.add(undefined, 'conn-A', 'req-1');
	routes.add('', 'conn-A', 'req-1');
	assert.equal(routes.__entries.size, 0);
});

test('RunEventRoutes: add 缺 connId 静默返回', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', undefined, 'req-1');
	routes.add('run-1', '', 'req-1');
	assert.equal(routes.__entries.size, 0);
});

test('RunEventRoutes: add 缺 reqId 静默返回', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', undefined);
	routes.add('run-1', 'conn-A', '');
	assert.equal(routes.__entries.size, 0);
});

test('RunEventRoutes: 同 reqId 重发严格刷新 expireAt（mock Date.now）', () => {
	const clock = patchDateNow(1_000_000);
	try {
		const routes = new RunEventRoutes({ ttlMs: 10_000 });
		routes.add('run-1', 'conn-A', 'req-1');
		const firstExpire = routes.__entries.get('run-1').expireAt;
		assert.equal(firstExpire, 1_010_000);

		clock.advance(1_000); // 推进 1s
		routes.add('run-1', 'conn-A', 'req-1');
		const secondExpire = routes.__entries.get('run-1').expireAt;
		assert.equal(secondExpire, 1_011_000, '重发应刷新到新 now + ttlMs');
		assert.equal(secondExpire - firstExpire, 1_000, '差值应等于推进的时间');
		assert.equal(routes.lookup('run-1'), 'conn-A');
	} finally {
		clock.restore();
	}
});

test('RunEventRoutes: 同 reqId 重发即使传入不同 connId 也锁死首发 connId', () => {
	const clock = patchDateNow(1_000_000);
	try {
		const routes = new RunEventRoutes({ ttlMs: 10_000 });
		routes.add('run-1', 'conn-A', 'req-1');
		clock.advance(500);
		// 异常场景：同 reqId 但 connId 不同（理论不应发生，但守住首发 connId 更安全）
		routes.add('run-1', 'conn-B', 'req-1');
		assert.equal(routes.lookup('run-1'), 'conn-A', 'connId 不应被覆盖');
		assert.equal(routes.__entries.get('run-1').connId, 'conn-A');
		assert.equal(routes.__entries.get('run-1').expireAt, 1_010_500, 'expireAt 仍刷新');
	} finally {
		clock.restore();
	}
});

test('RunEventRoutes: 不同 reqId 已存在则跳过覆盖（首发优先），打 debug 日志', () => {
	const logger = makeLogger();
	const routes = new RunEventRoutes({ logger });
	routes.add('run-1', 'conn-A', 'req-1');
	routes.add('run-1', 'conn-B', 'req-2');
	assert.equal(routes.lookup('run-1'), 'conn-A', 'lookup 仍返回首发 connId');
	assert.equal(routes.__entries.get('run-1').reqId, 'req-1', 'reqId 仍是首发');
	assert.equal(logger.debugs.length, 1, '应打一行 debug');
	assert.match(logger.debugs[0], /add skipped/);
});

test('RunEventRoutes: 不同 reqId 跳过覆盖时 logger.debug 缺失也安全', () => {
	// 模拟 pino 风格 logger 没有 debug 方法
	const routes = new RunEventRoutes({ logger: { warn() {}, info() {} } });
	routes.add('run-1', 'conn-A', 'req-1');
	routes.add('run-1', 'conn-B', 'req-2'); // 不应抛
	assert.equal(routes.lookup('run-1'), 'conn-A');
});

test('RunEventRoutes: 不同 reqId 跳过覆盖时 logger.debug 抛错也不传染 add', () => {
	const logger = {
		warn() {},
		info() {},
		debug() { throw new Error('logger boom'); },
	};
	const routes = new RunEventRoutes({ logger });
	routes.add('run-1', 'conn-A', 'req-1');
	assert.doesNotThrow(() => routes.add('run-1', 'conn-B', 'req-2'));
	assert.equal(routes.lookup('run-1'), 'conn-A', '首发条目应保留');
});

// --- 删除：remove ---

test('RunEventRoutes: remove reqId 匹配则删', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.remove('run-1', 'req-1');
	assert.equal(routes.lookup('run-1'), undefined);
	assert.equal(routes.__entries.size, 0);
});

test('RunEventRoutes: remove reqId 不匹配则不删', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.remove('run-1', 'req-2');
	assert.equal(routes.lookup('run-1'), 'conn-A', '不匹配不应删除');
});

test('RunEventRoutes: remove runId 不在表则静默 no-op', () => {
	const routes = new RunEventRoutes();
	routes.remove('ghost-run', 'req-1'); // 不抛
	assert.equal(routes.__entries.size, 0);
});

test('RunEventRoutes: remove 缺参数静默返回', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.remove(undefined, 'req-1');
	routes.remove('run-1', undefined);
	routes.remove('', 'req-1');
	routes.remove('run-1', '');
	assert.equal(routes.lookup('run-1'), 'conn-A', '缺参不应触发删除');
});

// --- 查询：lookup ---

test('RunEventRoutes: lookup 命中返回 connId', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	assert.equal(routes.lookup('run-1'), 'conn-A');
});

test('RunEventRoutes: lookup 未命中返回 undefined', () => {
	const routes = new RunEventRoutes();
	assert.equal(routes.lookup('ghost'), undefined);
});

test('RunEventRoutes: lookup 缺 runId 返回 undefined', () => {
	const routes = new RunEventRoutes();
	assert.equal(routes.lookup(undefined), undefined);
	assert.equal(routes.lookup(''), undefined);
});

test('RunEventRoutes: lookup 不顺手清过期条目（hot path 保持简单）', () => {
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes({ ttlMs: 5, scanMs: 10_000 });
		routes.init(); // timer 起来但不主动触发
		routes.add('run-1', 'conn-A', 'req-1');
		clock.advance(100); // ttl=5ms 已过
		// scan 没被触发，所以条目仍在表里
		assert.equal(routes.__entries.has('run-1'), true, '过期条目仍在表');
		assert.equal(routes.lookup('run-1'), 'conn-A', 'lookup 不清过期，仍返回 connId');
		assert.equal(routes.__entries.has('run-1'), true, 'lookup 后条目仍在表');
	} finally {
		patch.restore();
		clock.restore();
	}
});

// --- 周期扫描：__scanExpired ---

test('RunEventRoutes: scan 删过期条目并打 warn 日志', () => {
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		const logger = makeLogger();
		const routes = new RunEventRoutes({ logger, ttlMs: 100, scanMs: 1000 });
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		routes.add('run-2', 'conn-B', 'req-2');

		clock.advance(200); // 推过 ttl
		patch.captured[0].__fn(); // 手动触发 scan

		assert.equal(routes.lookup('run-1'), undefined, 'run-1 应被 scan 清掉');
		assert.equal(routes.lookup('run-2'), undefined, 'run-2 应被 scan 清掉');
		assert.equal(logger.warns.length, 1, '清理时应打一行 warn');
		assert.match(logger.warns[0], /expired entries cleaned: count=2/);
	} finally {
		patch.restore();
		clock.restore();
	}
});

test('RunEventRoutes: scan 不删未过期条目，清理数=0 时不打 warn', () => {
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		const logger = makeLogger();
		const routes = new RunEventRoutes({ logger, ttlMs: 10_000, scanMs: 1000 });
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		clock.advance(100); // 远小于 ttl
		patch.captured[0].__fn();
		assert.equal(routes.lookup('run-1'), 'conn-A', '未过期不应被清');
		assert.equal(logger.warns.length, 0, '清理数=0 时不打 warn');
	} finally {
		patch.restore();
		clock.restore();
	}
});

test('RunEventRoutes: scan 边界：expireAt === now 也算过期（<= 语义）', () => {
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		const logger = makeLogger();
		const routes = new RunEventRoutes({ logger, ttlMs: 100, scanMs: 1000 });
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		// expireAt 此刻 = 1_000_100；推到正好相等
		clock.set(1_000_100);
		patch.captured[0].__fn();
		assert.equal(routes.lookup('run-1'), undefined, 'expireAt === now 应被清（<= 语义）');
	} finally {
		patch.restore();
		clock.restore();
	}
});

test('RunEventRoutes: scan 内 logger.warn 抛错被 try/catch 吞掉，过期条目仍先于 warn 删除', () => {
	// 注：本测试不验证 setInterval 在 callback 抛错后的调度容错（那是 Node 平台保证），
	// 只验证 __scanExpired 内的 try/catch 真把 logger.warn 抛出的异常吞掉、且删除发生在 warn 之前。
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		let warnCallCount = 0;
		const logger = {
			warn() {
				warnCallCount += 1;
				throw new Error('logger boom');
			},
			info() {},
			debug() {},
			error() {},
		};
		const routes = new RunEventRoutes({ logger, ttlMs: 100, scanMs: 1000 });
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		clock.advance(200);

		// 第一次手动触发 scan：进 logger.warn → 抛错 → 被 try/catch 吞掉
		assert.doesNotThrow(() => patch.captured[0].__fn());
		assert.equal(warnCallCount, 1, 'logger.warn 应被调到');
		assert.equal(routes.__entries.size, 0, '过期条目应在 logger.warn 之前完成删除');

		// 第二次手动触发 scan：表已空，cleaned=0 不进 warn 分支
		assert.doesNotThrow(() => patch.captured[0].__fn());
		assert.equal(warnCallCount, 1, 'cleaned=0 时不应再调 logger.warn');
	} finally {
		patch.restore();
		clock.restore();
	}
});

test('RunEventRoutes: scan 内 logger.warn 缺失（pino 风格）安全', () => {
	const clock = patchDateNow(1_000_000);
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes({ logger: { info() {} }, ttlMs: 100, scanMs: 1000 });
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		clock.advance(200);
		assert.doesNotThrow(() => patch.captured[0].__fn());
		assert.equal(routes.__entries.size, 0);
	} finally {
		patch.restore();
		clock.restore();
	}
});

// --- 整表清空：clear ---

test('RunEventRoutes: clear 后表为空、lookup undefined', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.add('run-2', 'conn-B', 'req-2');
	routes.clear();
	assert.equal(routes.__entries.size, 0);
	assert.equal(routes.lookup('run-1'), undefined);
	assert.equal(routes.lookup('run-2'), undefined);
});

test('RunEventRoutes: clear 不停 timer', () => {
	const patch = patchInterval();
	try {
		const routes = new RunEventRoutes();
		routes.init();
		routes.add('run-1', 'conn-A', 'req-1');
		routes.clear();
		assert.equal(patch.cleared.length, 0, 'clear 不应调 clearInterval');
		assert.equal(routes.__scanTimer, patch.captured[0], 'timer 句柄应保留');
	} finally {
		patch.restore();
	}
});

test('RunEventRoutes: clear 后 add / lookup 仍正常工作（不退化为 no-op）', () => {
	// 场景：网关 WS 断开 → clear 整表；网关重连后续 res accepted 应能再次 add。
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.clear();
	routes.add('run-2', 'conn-B', 'req-2');
	assert.equal(routes.lookup('run-2'), 'conn-B', 'clear 后 add 仍生效');
	assert.equal(routes.lookup('run-1'), undefined, '清掉的 run-1 不复活');
});

// --- 真实场景补充 ---

test('RunEventRoutes: 不同 reqId 即使 connId 相同也跳过覆盖（首发优先只看 reqId）', () => {
	const logger = makeLogger();
	const routes = new RunEventRoutes({ logger });
	routes.add('run-1', 'conn-A', 'req-1');
	routes.add('run-1', 'conn-A', 'req-2');
	assert.equal(routes.lookup('run-1'), 'conn-A');
	assert.equal(routes.__entries.get('run-1').reqId, 'req-1', 'reqId 锁定首发');
	assert.equal(logger.debugs.length, 1, '应触发 skip 分支的 debug 日志');
});

test('RunEventRoutes: 字符串 runId 是 truthy 值（"0" / "undefined" / "false"）也能正常添加', () => {
	const routes = new RunEventRoutes();
	routes.add('0', 'conn-A', 'req-A');
	routes.add('undefined', 'conn-B', 'req-B');
	routes.add('false', 'conn-C', 'req-C');
	assert.equal(routes.lookup('0'), 'conn-A', '字符串 "0" 是 truthy，不应被 falsy 守卫过滤');
	assert.equal(routes.lookup('undefined'), 'conn-B');
	assert.equal(routes.lookup('false'), 'conn-C');
});

test('RunEventRoutes: 同 connId 绑定多个 runId，lookup 各自独立', () => {
	const routes = new RunEventRoutes();
	routes.add('run-1', 'conn-A', 'req-1');
	routes.add('run-2', 'conn-A', 'req-2');
	routes.add('run-3', 'conn-A', 'req-3');
	assert.equal(routes.lookup('run-1'), 'conn-A');
	assert.equal(routes.lookup('run-2'), 'conn-A');
	assert.equal(routes.lookup('run-3'), 'conn-A');
	assert.equal(routes.__entries.size, 3);
});

test('RunEventRoutes: add / remove 循环后 Map 清零，无残留', () => {
	const routes = new RunEventRoutes();
	for (let i = 0; i < 100; i += 1) {
		routes.add(`run-${i}`, `conn-${i}`, `req-${i}`);
	}
	assert.equal(routes.__entries.size, 100);
	for (let i = 0; i < 100; i += 1) {
		routes.remove(`run-${i}`, `req-${i}`);
	}
	assert.equal(routes.__entries.size, 0, 'remove 后 Map 应彻底清零');
});

test('RunEventRoutes: 显式传 logger=null 也 fallback 到 console（nullish coalescing 语义）', () => {
	const routes = new RunEventRoutes({ logger: null });
	assert.equal(routes.logger, console);
	// 后续操作（含跳过覆盖时的 console.debug）不抛；stub console.debug 避免污染测试输出
	const originalDebug = console.debug;
	console.debug = () => {};
	try {
		routes.add('run-1', 'conn-A', 'req-1');
		routes.add('run-1', 'conn-B', 'req-2');
		assert.equal(routes.lookup('run-1'), 'conn-A');
	} finally {
		console.debug = originalDebug;
	}
});
