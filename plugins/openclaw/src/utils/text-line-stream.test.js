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

test('iterTextLines: large text with yieldEvery=1 still produces correct output', async () => {
	const text = 'x\ny\nz\n';
	const out = await collect(text, { yieldEvery: 1 });
	assert.deepEqual(out, ['x', 'y', 'z']);
});
