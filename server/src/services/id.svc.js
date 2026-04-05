import { Snowflake } from '../utils/snowflake.js';

// userId：12 位十进制数字（~2039 年前），之后 13 位
// 若将来需要短号（如 10 位数字的"可虾号"），可在 DB User 表中渐进式补充 imId unique 字段
const userIdSnowflake = new Snowflake({
	epoch: Date.parse('2024-01-01T00:00:00.000Z'), // 绝对不可修改
	timeSliceMs: 1000,
	seqBits: 11, // seqBits + workerBits 绝对不可减小
	seqRandomBits: 10, // 用户显著增多时，可减少该值
	workerBits: 0,
	workerId: 0,
});

// clawId：12 位十进制数字（~2039 年前），之后 13 位
const clawIdSnowflake = new Snowflake({
	epoch: Date.parse('2024-01-01T00:00:00.000Z'), // 绝对不可修改
	timeSliceMs: 1000,
	seqBits: 11, // seqBits + workerBits 绝对不可减小
	seqRandomBits: 10, // claw 显著增多时，可减少该值
	workerBits: 0,
	workerId: 0,
});

export function genUserId() {
	return userIdSnowflake.nextId();
}

export function genClawId() {
	return clawIdSnowflake.nextId();
}
