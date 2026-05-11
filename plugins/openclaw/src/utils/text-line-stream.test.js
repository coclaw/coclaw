import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_YIELD_EVERY, iterTextLines } from './text-line-stream.js';

async function collect(text, opts) {
	const out = [];
	for await (const line of iterTextLines(text, opts)) out.push(line);
	return out;
}

test('iterTextLines: empty / non-string returns nothing', async () => {
	assert.deepEqual(await collect(''), []);
	assert.deepEqual(await collect(null), []);
	assert.deepEqual(await collect(undefined), []);
	assert.deepEqual(await collect(123), []);
});

test('iterTextLines: LF-terminated multi-line', async () => {
	const out = await collect('a\nb\nc\n');
	assert.deepEqual(out, ['a', 'b', 'c']);
});

test('iterTextLines: no trailing newline', async () => {
	const out = await collect('a\nb\nc');
	assert.deepEqual(out, ['a', 'b', 'c']);
});

test('iterTextLines: CRLF endings strip the \\r', async () => {
	const out = await collect('a\r\nb\r\nc\r\n');
	assert.deepEqual(out, ['a', 'b', 'c']);
});

test('iterTextLines: empty lines skipped by default', async () => {
	const out = await collect('a\n\n\nb\n');
	assert.deepEqual(out, ['a', 'b']);
});

test('iterTextLines: skipEmpty=false preserves empty lines', async () => {
	// 注：trailing \n 视作行终止符，不产生尾部空行
	const out = await collect('a\n\nb\n', { skipEmpty: false });
	assert.deepEqual(out, ['a', '', 'b']);
});

test('iterTextLines: single line, no newline', async () => {
	const out = await collect('only-line');
	assert.deepEqual(out, ['only-line']);
});

test('iterTextLines: only newlines yields nothing (default skipEmpty)', async () => {
	const out = await collect('\n\n\n');
	assert.deepEqual(out, []);
});

test('iterTextLines: yieldEvery defaults to DEFAULT_YIELD_EVERY (100)', async () => {
	assert.equal(DEFAULT_YIELD_EVERY, 100);
});

test('iterTextLines: yields setImmediate at the configured boundary', async () => {
	// 制造 250 行；yieldEvery=100 应触发至少 2 次 setImmediate
	const lines = [];
	for (let i = 0; i < 250; i++) lines.push(`row-${i}`);
	const text = lines.join('\n') + '\n';

	let immediateCount = 0;
	const origSetImmediate = global.setImmediate;
	global.setImmediate = (fn, ...args) => {
		immediateCount++;
		return origSetImmediate(fn, ...args);
	};
	try {
		const out = await collect(text, { yieldEvery: 100 });
		assert.equal(out.length, 250);
		assert.equal(out[0], 'row-0');
		assert.equal(out[249], 'row-249');
		// 250 行 / 100 = 2 次完整 yield（第 100、200 行后），第 250 行未到下一个边界
		assert.equal(immediateCount, 2);
	}
	finally {
		global.setImmediate = origSetImmediate;
	}
});

test('iterTextLines: invalid yieldEvery falls back to default', async () => {
	const text = 'a\nb\nc\n';
	assert.deepEqual(await collect(text, { yieldEvery: 0 }), ['a', 'b', 'c']);
	assert.deepEqual(await collect(text, { yieldEvery: -5 }), ['a', 'b', 'c']);
	assert.deepEqual(await collect(text, { yieldEvery: NaN }), ['a', 'b', 'c']);
});

test('iterTextLines: handles consecutive CRLF correctly', async () => {
	const out = await collect('a\r\n\r\nb\r\n');
	assert.deepEqual(out, ['a', 'b']);
});

test('iterTextLines: trailing isolated \\r is preserved (no LF terminator)', async () => {
	// 与旧 split(/\r?\n/) 行为对齐：末尾段没有 LF 时不剥 \r
	// 旧 split('a\\r') => ['a\\r']，旧 split('\\r') => ['\\r']
	assert.deepEqual(await collect('a\r'), ['a\r']);
	assert.deepEqual(await collect('\r'), ['\r']);
	// 中间正常 \n + 末尾段 \r：第二行的 \r 必须保留
	assert.deepEqual(await collect('a\nb\r'), ['a', 'b\r']);
});

test('iterTextLines: large text with yieldEvery=1 still produces correct output', async () => {
	const text = 'x\ny\nz\n';
	const out = await collect(text, { yieldEvery: 1 });
	assert.deepEqual(out, ['x', 'y', 'z']);
});

test('iterTextLines: multi-MB single line with no newline emits intact', async () => {
	// 真实场景：用户粘贴一大段文本到对话，单行可能数 MB
	const huge = 'x'.repeat(5 * 1024 * 1024);
	const out = await collect(huge);
	assert.equal(out.length, 1);
	assert.equal(out[0].length, huge.length);
	assert.equal(out[0], huge);
});

test('iterTextLines: line count just below yieldEvery (99) never yields', async () => {
	// 紧贴下边界：能咬住"边界判断从 % === 0 滑成 >= yieldEvery"这类回归
	const lines = [];
	for (let i = 0; i < 99; i++) lines.push(`r${i}`);
	const text = lines.join('\n') + '\n';

	let count = 0;
	const orig = global.setImmediate;
	global.setImmediate = (fn, ...args) => { count++; return orig(fn, ...args); };
	try {
		const out = await collect(text, { yieldEvery: 100 });
		assert.deepEqual(out, lines);
		assert.equal(count, 0);
	}
	finally { global.setImmediate = orig; }
});

test('iterTextLines: line count exactly equals yieldEvery yields once', async () => {
	const lines = [];
	for (let i = 0; i < 100; i++) lines.push(`r${i}`);
	const text = lines.join('\n') + '\n';

	let count = 0;
	const orig = global.setImmediate;
	global.setImmediate = (fn, ...args) => { count++; return orig(fn, ...args); };
	try {
		const out = await collect(text, { yieldEvery: 100 });
		assert.deepEqual(out, lines);
		// 第 100 行处理后命中边界让出一次；第 101 行起没有了
		assert.equal(count, 1);
	}
	finally { global.setImmediate = orig; }
});
