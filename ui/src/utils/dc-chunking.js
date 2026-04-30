/**
 * DataChannel 应用层分片/重组（浏览器侧）
 * 协议：普通消息用 string，分片消息用 binary（ArrayBuffer）
 *
 * 二进制帧格式：
 *   Byte 0:   flag (0x01=BEGIN, 0x00=MIDDLE, 0x02=END)
 *   Byte 1-4: msgId (uint32 BE)
 *   Byte 5+:  UTF-8 数据片段
 */

import { remoteLog } from '../services/remote-log.js';

/** orphan-chunk 远程日志限频窗口（同窗口内仅首条上报，其余累计到 suppressed） */
export const ORPHAN_REMOTE_LOG_WINDOW_MS = 5_000;

export const FLAG_BEGIN = 0x01;
export const FLAG_MIDDLE = 0x00;
export const FLAG_END = 0x02;
export const HEADER_SIZE = 5; // 1 flag + 4 msgId

/** 单条消息重组缓冲区上限 */
export const MAX_REASSEMBLY_BYTES = 50 * 1024 * 1024;
/** 单条消息最大 chunk 数 */
export const MAX_CHUNKS_PER_MSG = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 将 JSON 字符串按需分片为 ArrayBuffer 数组
 * @param {string} jsonStr - 已序列化的 JSON 字符串
 * @param {number} maxMessageSize - 对端声明的 maxMessageSize
 * @param {() => number} getNextMsgId - 获取下一个 msgId
 * @returns {null | ArrayBuffer[]} null 表示不需要分片，否则返回 chunk 数组
 */
export function buildChunks(jsonStr, maxMessageSize, getNextMsgId) {
	const fullBytes = encoder.encode(jsonStr);
	if (fullBytes.byteLength <= maxMessageSize) return null;

	const chunkPayloadSize = maxMessageSize - HEADER_SIZE;
	if (chunkPayloadSize <= 0) {
		throw new Error(`maxMessageSize (${maxMessageSize}) too small for chunking header`);
	}

	const msgId = getNextMsgId();
	const totalChunks = Math.ceil(fullBytes.byteLength / chunkPayloadSize);
	console.debug(`[dc-chunking] chunking msgId=${msgId}: ${fullBytes.byteLength} bytes → ${totalChunks} chunks (maxMsgSize=${maxMessageSize})`);
	const chunks = [];

	for (let i = 0; i < totalChunks; i++) {
		const start = i * chunkPayloadSize;
		const end = Math.min(start + chunkPayloadSize, fullBytes.byteLength);
		const flag = i === 0 ? FLAG_BEGIN : (i === totalChunks - 1 ? FLAG_END : FLAG_MIDDLE);

		const chunk = new Uint8Array(HEADER_SIZE + (end - start));
		chunk[0] = flag;
		new DataView(chunk.buffer).setUint32(1, msgId, false); // BE
		chunk.set(fullBytes.subarray(start, end), HEADER_SIZE);

		chunks.push(chunk.buffer);
	}
	return chunks;
}

/**
 * 创建分片重组器
 * @param {(jsonStr: string) => void} onComplete - 完整消息回调
 * @returns {{ feed: (data: string|ArrayBuffer) => void, reset: () => void }}
 */
export function createReassembler(onComplete) {
	/** @type {Map<number, { chunks: Uint8Array[], totalBytes: number }>} */
	const pending = new Map();
	// orphan-chunk（非 BEGIN 但 pending 不存在）远程日志限频窗口状态。
	// 这是 string 帧被错当 binary 帧时会大量踩到的分支，本地全量 console.warn 便于实时观察，
	// remoteLog 限频避免对端上行风暴。
	let lastOrphanRemoteAt = 0;
	let orphanSuppressed = 0;

	function reportOrphanChunk(flag, msgId) {
		const flagName = flag === FLAG_END ? 'END' : (flag === FLAG_MIDDLE ? 'MIDDLE' : `0x${flag.toString(16)}`);
		console.warn(`[dc-chunking] reassembler drop orphan-chunk flag=${flagName} msgId=${msgId}`);
		const now = Date.now();
		if (now - lastOrphanRemoteAt >= ORPHAN_REMOTE_LOG_WINDOW_MS) {
			remoteLog(`reassembler.orphan flag=${flagName} msgId=${msgId} suppressed=${orphanSuppressed}`);
			lastOrphanRemoteAt = now;
			orphanSuppressed = 0;
		} else {
			orphanSuppressed += 1;
		}
	}

	function feed(data) {
		// string = 普通消息
		if (typeof data === 'string') {
			onComplete(data);
			return;
		}

		// binary = 分片 chunk
		const buf = new Uint8Array(data);
		if (buf.length < HEADER_SIZE) {
			console.warn(`[dc-chunking] reassembler drop short-frame bytes=${buf.length}`);
			return;
		}

		const flag = buf[0];
		const msgId = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
		const payload = buf.subarray(HEADER_SIZE);

		if (flag === FLAG_BEGIN) {
			// 正常情况下 plugin 端 msgId 单调递增不重复；若已存在同 msgId 的 pending 旧 entry
			// 说明对端可能重启了 msgId 计数或上一条消息分片未送完，按"新 BEGIN 覆盖旧"语义处理
			if (pending.has(msgId)) {
				console.warn(`[dc-chunking] reassembler drop begin-overwrite msgId=${msgId}`);
			}
			pending.set(msgId, { chunks: [payload], totalBytes: payload.length });
			return;
		}

		const entry = pending.get(msgId);
		if (!entry) {
			reportOrphanChunk(flag, msgId);
			return;
		}

		entry.totalBytes += payload.length;
		if (entry.totalBytes > MAX_REASSEMBLY_BYTES || entry.chunks.length >= MAX_CHUNKS_PER_MSG) {
			console.warn(`[dc-chunking] reassembler drop oversize msgId=${msgId} totalBytes=${entry.totalBytes} chunks=${entry.chunks.length}`);
			pending.delete(msgId);
			return;
		}

		entry.chunks.push(payload);

		if (flag === FLAG_END) {
			pending.delete(msgId);
			const totalLen = entry.chunks.reduce((s, c) => s + c.length, 0);
			const merged = new Uint8Array(totalLen);
			let offset = 0;
			for (const c of entry.chunks) {
				merged.set(c, offset);
				offset += c.length;
			}
			console.debug(`[dc-chunking] reassembled msgId=${msgId}: ${entry.chunks.length} chunks, ${totalLen} bytes`);
			onComplete(decoder.decode(merged));
		}
	}

	function reset() {
		pending.clear();
	}

	return { feed, reset };
}
