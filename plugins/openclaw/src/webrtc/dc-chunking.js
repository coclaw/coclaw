/**
 * DataChannel 应用层分片/重组
 * 协议：普通消息用 string，分片消息用 binary（Buffer）
 *
 * 二进制帧格式：
 *   Byte 0:   flag (0x01=BEGIN, 0x00=MIDDLE, 0x02=END)
 *   Byte 1-4: msgId (uint32 BE)
 *   Byte 5+:  UTF-8 数据片段
 */

export const FLAG_BEGIN = 0x01;
export const FLAG_MIDDLE = 0x00;
export const FLAG_END = 0x02;
export const HEADER_SIZE = 5; // 1 flag + 4 msgId

/** 单条消息重组缓冲区上限 */
export const MAX_REASSEMBLY_BYTES = 50 * 1024 * 1024;
/** 单条消息最大 chunk 数（防止无 END 的 BEGIN 泄漏） */
export const MAX_CHUNKS_PER_MSG = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 按需分片并发送消息
 * 小于 maxMessageSize 直接发 string；否则切成 binary chunk 逐个发送
 * @param {object} dc - DataChannel（werift 或浏览器）
 * @param {string} jsonStr - 已序列化的 JSON 字符串
 * @param {number} maxMessageSize - 对端声明的 maxMessageSize
 * @param {() => number} getNextMsgId - 获取下一个 msgId
 */
export function chunkAndSend(dc, jsonStr, maxMessageSize, getNextMsgId, logger) {
	const fullBytes = encoder.encode(jsonStr);
	// 快路径：不需要分片
	if (fullBytes.byteLength <= maxMessageSize) {
		dc.send(jsonStr);
		return;
	}

	const chunkPayloadSize = maxMessageSize - HEADER_SIZE;
	if (chunkPayloadSize <= 0) {
		throw new Error(`maxMessageSize (${maxMessageSize}) too small for chunking header`);
	}

	const msgId = getNextMsgId();
	const totalChunks = Math.ceil(fullBytes.byteLength / chunkPayloadSize);
	logger?.info?.(`[dc-chunking] chunking msgId=${msgId}: ${fullBytes.byteLength} bytes → ${totalChunks} chunks (maxMsgSize=${maxMessageSize})`);

	for (let i = 0; i < totalChunks; i++) {
		const start = i * chunkPayloadSize;
		const end = Math.min(start + chunkPayloadSize, fullBytes.byteLength);
		const flag = i === 0 ? FLAG_BEGIN : (i === totalChunks - 1 ? FLAG_END : FLAG_MIDDLE);

		const chunk = Buffer.allocUnsafe(HEADER_SIZE + (end - start));
		chunk[0] = flag;
		chunk.writeUInt32BE(msgId, 1);
		chunk.set(fullBytes.subarray(start, end), HEADER_SIZE);

		dc.send(chunk);
	}
}

/**
 * 创建分片重组器
 * @param {(jsonStr: string) => void} onComplete - 完整消息回调
 * @param {object} [opts]
 * @param {object} [opts.logger] - warn 日志输出
 * @returns {{ feed: (data: string|Buffer) => void, reset: () => void }}
 */
export function createReassembler(onComplete, opts = {}) {
	const logger = opts.logger;
	/** @type {Map<number, { chunks: Buffer[], totalBytes: number }>} */
	const pending = new Map();

	function feed(data) {
		// string = 普通消息，直接交付
		if (typeof data === 'string') {
			onComplete(data);
			return;
		}

		// binary = 分片 chunk
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (buf.length < HEADER_SIZE) {
			logger?.warn?.('[dc-chunking] chunk too short, discarding'); /* c8 ignore -- ?./?. fallback */
			return;
		}

		const flag = buf[0];
		const msgId = buf.readUInt32BE(1);
		const payload = buf.subarray(HEADER_SIZE);

		if (flag === FLAG_BEGIN) {
			// 若已有同 msgId 的未完成重组，丢弃旧的
			if (pending.has(msgId)) {
				logger?.warn?.(`[dc-chunking] orphan reassembly discarded for msgId=${msgId}`);
			}
			pending.set(msgId, { chunks: [payload], totalBytes: payload.length });
			return;
		}

		const entry = pending.get(msgId);
		if (!entry) {
			logger?.warn?.(`[dc-chunking] chunk for unknown msgId=${msgId}, discarding`);
			return;
		}

		entry.totalBytes += payload.length;

		// 安全检查：缓冲区大小上限
		if (entry.totalBytes > MAX_REASSEMBLY_BYTES) {
			logger?.warn?.(`[dc-chunking] reassembly buffer exceeded ${MAX_REASSEMBLY_BYTES} bytes for msgId=${msgId}, discarding`);
			pending.delete(msgId);
			return;
		}

		// 安全检查：chunk 数量上限
		if (entry.chunks.length >= MAX_CHUNKS_PER_MSG) {
			logger?.warn?.(`[dc-chunking] too many chunks for msgId=${msgId}, discarding`);
			pending.delete(msgId);
			return;
		}

		entry.chunks.push(payload);

		if (flag === FLAG_END) {
			pending.delete(msgId);
			const merged = Buffer.concat(entry.chunks);
			logger?.info?.(`[dc-chunking] reassembled msgId=${msgId}: ${entry.chunks.length} chunks, ${merged.length} bytes`);
			onComplete(decoder.decode(merged));
		}
		// flag === FLAG_MIDDLE → 继续等待
	}

	function reset() {
		pending.clear();
	}

	return { feed, reset };
}
