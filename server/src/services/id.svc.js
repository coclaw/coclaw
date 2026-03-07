import { Snowflake } from '../utils/snowflake.js';

const userIdSnowflake = new Snowflake({
	workerBits: 0,
	workerId: 0,
	seqRandomBits: 10,
});

const botIdSnowflake = new Snowflake({
	workerBits: 0,
	workerId: 0,
	seqRandomBits: 10,
});

export function genUserId() {
	return userIdSnowflake.nextId();
}

export function genBotId() {
	return botIdSnowflake.nextId();
}
