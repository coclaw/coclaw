import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { getPlatformInfoLine, __resetPlatformInfoCache } from './platform-info.js';

// 每个测试前清缓存，避免 monkey-patch 被前一次测试缓存的值掩盖
test.beforeEach(() => { __resetPlatformInfoCache(); });

// --- 基本字段 ---

test('getPlatformInfoLine includes all core fields in happy path', () => {
	const line = getPlatformInfoLine();
	// platform / arch / node 永远应当存在
	assert.match(line, /\bplatform=[a-z0-9]+\b/);
	assert.match(line, /\barch=[a-z0-9]+\b/);
	assert.match(line, /\bnode=v\d+\.\d+\.\d+/);
	// osrel / cores / mem 在主流平台上均可获取
	assert.match(line, /\bosrel=\S+/);
	assert.match(line, /\bcores=\d+\b/);
	assert.match(line, /\bmem=\d+(?:\.\d+)?GB\b/);
	// cpu 字段带双引号包裹
	assert.match(line, /\bcpu="[^"]+"/);
});

test('getPlatformInfoLine is a single-line string without consecutive whitespace', () => {
	const line = getPlatformInfoLine();
	assert.ok(!/\n/.test(line), 'should not contain newlines');
	// cpu="..." 内部可能含单空格；校验不出现制表/连续空格即可
	assert.ok(!/\t/.test(line), 'should not contain tabs');
	assert.ok(!/  +(?=\w+=)/.test(line), 'no double spaces between key=value tokens');
});

// --- 尽力而为：单项抛异常不影响其它字段 ---

test('getPlatformInfoLine omits cpu/cores when os.cpus throws, keeps other fields', (t) => {
	const origCpus = os.cpus;
	os.cpus = () => { throw new Error('cpus-boom'); };
	t.after(() => { os.cpus = origCpus; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bcpu=/.test(line));
	assert.ok(!/\bcores=/.test(line));
	// 其它字段仍应存在
	assert.match(line, /\bplatform=/);
	assert.match(line, /\barch=/);
	assert.match(line, /\bnode=/);
});

test('getPlatformInfoLine omits mem when os.totalmem throws', (t) => {
	const origTotalmem = os.totalmem;
	os.totalmem = () => { throw new Error('mem-boom'); };
	t.after(() => { os.totalmem = origTotalmem; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bmem=/.test(line));
	assert.match(line, /\bplatform=/);
});

test('getPlatformInfoLine omits mem when os.totalmem returns non-finite', (t) => {
	const origTotalmem = os.totalmem;
	os.totalmem = () => 0; // 0 / NaN / Infinity 都应跳过
	t.after(() => { os.totalmem = origTotalmem; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bmem=/.test(line));
});

test('getPlatformInfoLine omits cpu when os.cpus returns empty array', (t) => {
	const origCpus = os.cpus;
	os.cpus = () => [];
	t.after(() => { os.cpus = origCpus; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bcpu=/.test(line));
	// cores 字段在 cpus=[] 时长度为 0，也会被跳过（空值判定）
	assert.ok(!/\bcores=/.test(line));
});

test('getPlatformInfoLine omits osrel when os.release throws', (t) => {
	const origRelease = os.release;
	os.release = () => { throw new Error('release-boom'); };
	t.after(() => { os.release = origRelease; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bosrel=/.test(line));
	assert.match(line, /\bplatform=/);
});

test('getPlatformInfoLine cpu model is trimmed and wrapped in quotes', (t) => {
	const origCpus = os.cpus;
	os.cpus = () => [{ model: '  Intel(R)   Xeon(R)   CPU  ' }];
	t.after(() => { os.cpus = origCpus; });
	const line = getPlatformInfoLine();
	assert.match(line, /\bcpu="Intel\(R\) Xeon\(R\) CPU"/);
});

test('getPlatformInfoLine sanitizes embedded quotes/newlines in cpu model', (t) => {
	const origCpus = os.cpus;
	os.cpus = () => [{ model: 'Some "Weird"\n\tChip' }];
	t.after(() => { os.cpus = origCpus; });
	const line = getPlatformInfoLine();
	// 内部双引号/换行被替换为空格，外层引号仍成对 — 解析端能用简单正则切出 value
	assert.match(line, /\bcpu="Some Weird Chip"/);
	// 确保 cpu value 内无换行 / tab / 嵌套双引号
	const cpuMatch = line.match(/\bcpu="([^"]*)"/);
	assert.ok(cpuMatch, 'cpu field should be parseable by `cpu="([^"]*)"`');
	assert.ok(!/["\n\r\t]/.test(cpuMatch[1]));
});

test('getPlatformInfoLine omits cpu when model is empty/whitespace-only', (t) => {
	const origCpus = os.cpus;
	os.cpus = () => [{ model: '   \t\n  ' }];
	t.after(() => { os.cpus = origCpus; });
	const line = getPlatformInfoLine();
	assert.ok(!/\bcpu=/.test(line), `cpu should be omitted for whitespace-only model: ${line}`);
});

test('getPlatformInfoLine caches result across calls (second call invokes no resolvers)', (t) => {
	let cpusCalls = 0;
	let totalmemCalls = 0;
	const origCpus = os.cpus;
	const origTotalmem = os.totalmem;
	os.cpus = () => { cpusCalls += 1; return origCpus.call(os); };
	os.totalmem = () => { totalmemCalls += 1; return origTotalmem.call(os); };
	t.after(() => {
		os.cpus = origCpus;
		os.totalmem = origTotalmem;
	});
	const a = getPlatformInfoLine();
	// 快照首调后的计数（不与"一个字段对应一次调用"的实现细节耦合）
	const cpusAfterFirst = cpusCalls;
	const totalmemAfterFirst = totalmemCalls;
	const b = getPlatformInfoLine();
	const c = getPlatformInfoLine();
	assert.equal(a, b);
	assert.equal(b, c);
	// 缓存语义：后续调用不再触发任何 resolver
	assert.equal(cpusCalls, cpusAfterFirst, 'os.cpus should not be re-invoked after first call');
	assert.equal(totalmemCalls, totalmemAfterFirst, 'os.totalmem should not be re-invoked after first call');
});

test('__resetPlatformInfoCache forces recomputation', (t) => {
	const origCpus = os.cpus;
	let mockedReturn = [{ model: 'CPU-A' }];
	os.cpus = () => mockedReturn;
	t.after(() => { os.cpus = origCpus; });

	const first = getPlatformInfoLine();
	assert.match(first, /\bcpu="CPU-A"/);

	// 不 reset 时改 mock 不生效
	mockedReturn = [{ model: 'CPU-B' }];
	const cached = getPlatformInfoLine();
	assert.match(cached, /\bcpu="CPU-A"/, 'should return cached value');

	// reset 后重新计算
	__resetPlatformInfoCache();
	const fresh = getPlatformInfoLine();
	assert.match(fresh, /\bcpu="CPU-B"/, 'should pick up new mock after reset');
});

test('getPlatformInfoLine does not throw even when every field resolver fails', (t) => {
	const origCpus = os.cpus;
	const origTotalmem = os.totalmem;
	const origRelease = os.release;
	os.cpus = () => { throw new Error('x'); };
	os.totalmem = () => { throw new Error('x'); };
	os.release = () => { throw new Error('x'); };
	t.after(() => {
		os.cpus = origCpus;
		os.totalmem = origTotalmem;
		os.release = origRelease;
	});
	// 不抛 + 仍含 platform/arch/node（process.* 永远可读）
	const line = getPlatformInfoLine();
	assert.match(line, /\bplatform=/);
	assert.match(line, /\barch=/);
	assert.match(line, /\bnode=v/);
});
