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
	}, /workerId must be 0 when workerBits/);

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
		nowFn: createNowFn([1000, 1000, 1000, 1001]),
		randSeqFn: () => {
			const value = randomStarts[randomIndex];
			randomIndex += 1;
			return value;
		},
	});

	const id1 = flake.nextId(); // tick=1000, rand=1 → seq=1
	const id2 = flake.nextId(); // tick=1000, seq=2
	const id3 = flake.nextId(); // tick=1000, seq=3
	const id4 = flake.nextId(); // tick=1001 → resetTickState, rand=0 → seq=0

	assert.deepEqual(
		[Number(id1 & 3n), Number(id2 & 3n), Number(id3 & 3n), Number(id4 & 3n)],
		[1, 2, 3, 0],
	);
	assert.equal(randomIndex, 2);
	assert.ok((id4 >> 2n) > (id3 >> 2n));
});

test('seq 耗尽时预借下一个时间片，seq 从 0 开始', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 2,
		seqRandomBits: 2,
		nowFn: createNowFn([1000, 1000]),
		randSeqFn: () => 3n,
	});

	const id1 = flake.nextId(); // tick=1000, rand=3 → seq=3
	const id2 = flake.nextId(); // seq 耗尽 → 预借 tick=1001, seq=0

	assert.equal(Number(id1 & 3n), 3);
	assert.equal(Number(id2 & 3n), 0);
	assert.ok((id2 >> 2n) > (id1 >> 2n));
});

test('时钟回拨在容忍范围内不抛错，ID 保持递增', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 4,
		nowFn: createNowFn([1001, 1000, 1000]),
	});

	const id1 = flake.nextId(); // tick=1001
	const id2 = flake.nextId(); // tick=1000 < lastTick, seq 未耗尽 → 继续
	const id3 = flake.nextId();

	assert.ok(id2 > id1);
	assert.ok(id3 > id2);
});

test('时间早于 epoch 时抛错', () => {
	const flake = new Snowflake({
		epoch: 2000,
		nowFn: createNowFn([1000]),
	});

	assert.throws(() => {
		flake.nextId();
	}, /before epoch/);
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
	}, /workerId out of range/);

	const flakeOver = new Snowflake({
		epoch: 0,
		seqBits: 2,
		seqRandomBits: 1,
		randSeqFn: () => 2n,
		nowFn: createNowFn([1000]),
	});

	assert.throws(() => {
		flakeOver.nextId();
	}, /randSeqFn return value out of/);

	const flakeNeg = new Snowflake({
		epoch: 0,
		seqBits: 2,
		seqRandomBits: 1,
		randSeqFn: () => -1n,
		nowFn: createNowFn([1000]),
	});

	assert.throws(() => {
		flakeNeg.nextId();
	}, /randSeqFn return value out of/);
});

test('nowFn 返回无效值时抛错', () => {
	const flake = new Snowflake({
		nowFn: () => Number.NaN,
	});

	assert.throws(() => {
		flake.nextId();
	}, /nowFn must return a finite number/);
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

test('漂移超出 maxDrift 时抛错', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 1,
		maxDriftMs: 2,
		nowFn: createNowFn([1000, 1000, 1000, 1000, 1000, 1000, 1000]),
	});

	// seqBits=1 → 每个时间片 2 个 ID (seq 0, 1)
	flake.nextId(); // tick=1000, seq=0
	flake.nextId(); // tick=1000, seq=1
	flake.nextId(); // 预借 tick=1001, seq=0 (drift=1)
	flake.nextId(); // tick=1001, seq=1
	flake.nextId(); // 预借 tick=1002, seq=0 (drift=2)
	flake.nextId(); // tick=1002, seq=1

	assert.throws(() => {
		flake.nextId(); // 预借 tick=1003, drift=3 > maxDrift=2
	}, /drift exceeded/);
});

test('真实时间追平预借后不触发 rand，继续递增 seq', () => {
	let randCalls = 0;
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 1,
		seqRandomBits: 1,
		maxDriftMs: 3,
		nowFn: createNowFn([1000, 1000, 1001]),
		randSeqFn: () => { randCalls += 1; return 1n; },
	});

	flake.nextId(); // tick=1000, resetTickState → rand(seq=1), randCalls=1
	flake.nextId(); // tick=1000, seq 耗尽 → 预借 tick=1001, seq=0

	assert.equal(randCalls, 1);

	const id3 = flake.nextId(); // tick=1001 === lastTick=1001, seq 未耗尽 → 继续
	assert.equal(Number(id3 & 1n), 1); // seq=1 (接着预借的 seq=0 之后)
	assert.equal(randCalls, 1); // 未触发新的 rand
});

test('真实时间超过预借时 resetTickState 恢复随机', () => {
	let randCalls = 0;
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 1,
		seqRandomBits: 1,
		maxDriftMs: 3,
		nowFn: createNowFn([1000, 1000, 1003]),
		randSeqFn: () => { randCalls += 1; return 1n; },
	});

	flake.nextId(); // tick=1000, resetTickState → rand
	flake.nextId(); // 预借 tick=1001, seq=0

	assert.equal(randCalls, 1);

	flake.nextId(); // tick=1003 > lastTick=1001 → resetTickState → rand

	assert.equal(randCalls, 2);
});

test('大幅时钟回拨在 seq 未耗尽时立即抛错', () => {
	const flake = new Snowflake({
		epoch: 0,
		workerBits: 0,
		seqBits: 4,
		maxDriftMs: 3,
		nowFn: createNowFn([1100, 1090]),
	});

	flake.nextId(); // tick=1100, seq 未耗尽
	// tick=1090, 回拨 10 ticks > maxDrift=3, 应立即报错而非静默继续
	assert.throws(() => {
		flake.nextId();
	}, /drift exceeded/);
});

test('maxDriftMs 参数校验', () => {
	assert.throws(() => {
		new Snowflake({ maxDriftMs: -1 });
	}, /maxDriftMs/);
});
