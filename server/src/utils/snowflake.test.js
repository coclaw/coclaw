import assert from 'node:assert/strict';
import test from 'node:test';

import { Snowflake } from './snowflake.js';

/**
 * 创建一个按顺序返回时间值的 nowFn。
 * @param {number[]} values - 毫秒时间序列
 * @returns {() => number}
 */
function createNowFn(values) {
	let i = 0;
	return () => {
		const index = i < values.length ? i : values.length - 1;
		i += 1;
		return values[index];
	};
}

test('默认配置可生成 bigint 且递增', () => {
	const flake = new Snowflake({
		epoch: 0,
		nowFn: createNowFn([1000, 1000, 1001]),
	});

	const id1 = flake.nextId();
	const id2 = flake.nextId();
	const id3 = flake.nextId();

	assert.equal(typeof id1, 'bigint');
	assert.ok(id2 > id1);
	assert.ok(id3 > id2);
});

test('workerBits 为 0 时仅允许 workerId 为 0', () => {
	assert.throws(() => {
		new Snowflake({ workerBits: 0, workerId: 1 });
	}, /workerBits 为 0 时/);

	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 2,
		nowFn: createNowFn([10]),
	});
	assert.equal(flake.nextId(), 40n);
});

test('timeSliceMs 可按时间片编码', () => {
	const flake = new Snowflake({
		epoch: 0,
		timeSliceMs: 1000,
		workerBits: 1,
		seqBits: 1,
		workerId: 1,
		nowFn: createNowFn([2500]),
	});

	assert.equal(flake.nextId(), 10n);
});

test('seqRandomBits 启用后每个时间片首个 id 重新随机', () => {
	const randomStarts = [1n, 0n];
	let randomIndex = 0;
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 2,
		seqRandomBits: 1,
		nowFn: createNowFn([1000, 1000, 1000, 1000, 1000, 1001]),
		randSeqFn: () => {
			const value = randomStarts[randomIndex];
			randomIndex += 1;
			return value;
		},
	});

	const id1 = flake.nextId();
	const id2 = flake.nextId();
	const id3 = flake.nextId();
	const id4 = flake.nextId();

	assert.deepEqual(
		[Number(id1 & 3n), Number(id2 & 3n), Number(id3 & 3n), Number(id4 & 3n)],
		[1, 2, 3, 0],
	);
	assert.equal(randomIndex, 2);
	assert.ok((id4 >> 2n) > (id3 >> 2n));
});

test('seq 到达最大值后等待下一个时间片，不回绕', () => {
	const randomStarts = [3n, 1n];
	let randomIndex = 0;
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 2,
		seqRandomBits: 2,
		nowFn: createNowFn([1000, 1000, 1000, 1001]),
		randSeqFn: () => {
			const value = randomStarts[randomIndex];
			randomIndex += 1;
			return value;
		},
	});

	const id1 = flake.nextId();
	const id2 = flake.nextId();

	assert.equal(Number(id1 & 3n), 3);
	assert.equal(Number(id2 & 3n), 1);
	assert.ok((id2 >> 2n) > (id1 >> 2n));
	assert.equal(randomIndex, 2);
});

test('检测到时钟回拨时抛错', () => {
	const flake = new Snowflake({
		epoch: 0,
		nowFn: createNowFn([1001, 1000]),
	});

	flake.nextId();
	assert.throws(() => {
		flake.nextId();
	}, /时钟回拨/);
});

test('时间早于 epoch 时抛错', () => {
	const flake = new Snowflake({
		epoch: 2000,
		nowFn: createNowFn([1000]),
	});

	assert.throws(() => {
		flake.nextId();
	}, /早于 epoch/);
});

test('静态 genId 使用标准实例', () => {
	const original = Snowflake.standard;
	const custom = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 1,
		nowFn: createNowFn([1000]),
	});

	Snowflake.standard = custom;
	assert.equal(Snowflake.genId(), 2000n);
	Snowflake.standard = original;
});

test('构造参数校验分支', () => {
	assert.throws(() => {
		new Snowflake({ epoch: -1 });
	}, /epoch/);

	assert.throws(() => {
		new Snowflake({ workerBits: -1 });
	}, /workerBits/);

	assert.throws(() => {
		new Snowflake({ seqBits: -1 });
	}, /seqBits/);

	assert.throws(() => {
		new Snowflake({ workerId: -1 });
	}, /workerId/);

	assert.throws(() => {
		new Snowflake({ timeSliceMs: 0 });
	}, /timeSliceMs/);

	assert.throws(() => {
		new Snowflake({ timeSliceMs: 1001 });
	}, /timeSliceMs/);

	assert.throws(() => {
		new Snowflake({ seqRandomBits: -1 });
	}, /seqRandomBits/);

	assert.throws(() => {
		new Snowflake({ seqBits: 1, seqRandomBits: 2 });
	}, /seqRandomBits/);

	assert.throws(() => {
		new Snowflake({ nowFn: 1 });
	}, /nowFn/);

	assert.throws(() => {
		new Snowflake({ randSeqFn: 1 });
	}, /randSeqFn/);

	assert.throws(() => {
		new Snowflake({ workerBits: 1, workerId: 2 });
	}, /workerId 超出范围/);

	const flake = new Snowflake({
		epoch: 0,
		seqBits: 2,
		seqRandomBits: 1,
		randSeqFn: () => 2n,
		nowFn: createNowFn([1000]),
	});

	assert.throws(() => {
		flake.nextId();
	}, /randSeqFn 返回值超出 seqRandomBits 范围/);
});

test('nowFn 返回无效值时抛错', () => {
	const flake = new Snowflake({
		nowFn: () => Number.NaN,
	});

	assert.throws(() => {
		flake.nextId();
	}, /nowFn 返回值必须是有限数字/);
});

test('seqBits 为 0 时可正常工作', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 1,
		seqBits: 0,
		workerId: 1,
		nowFn: createNowFn([1000]),
	});

	assert.equal(flake.nextId(), 2001n);
});

test('seqRandomBits 默认为 0 且不触发 randSeqFn', () => {
	let called = 0;
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 5,
		nowFn: createNowFn([1000]),
		randSeqFn: () => {
			called += 1;
			return 0n;
		},
	});

	const id = flake.nextId();
	assert.equal(Number(id & 31n), 0);
	assert.equal(called, 0);
});

test('seqRandomBits 大于 0 且未提供 randSeqFn 时使用内置随机', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 5,
		seqRandomBits: 3,
		nowFn: createNowFn([1000]),
	});

	const id = flake.nextId();
	const seq = Number(id & 31n);
	assert.ok(seq >= 0 && seq <= 7);
});
