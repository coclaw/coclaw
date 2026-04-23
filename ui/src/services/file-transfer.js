/**
 * 文件传输服务（UI 侧）
 *
 * 基于 WebRTC DataChannel 实现 UI ↔ Plugin 的文件操作：
 * - list / delete / mkdir / create：走 rpc DataChannel（JSON-RPC）
 * - GET / PUT / POST：走独立 file:<transferId> DataChannel（自包含传输，HTTP 动词语义）
 *
 * 设计文档：docs/designs/file-management.md
 */
import { DEFAULT_CONNECT_TIMEOUT_MS } from './claw-connection.js';
import { remoteLog } from './remote-log.js';
import { formatFileSize } from '../utils/file-helper.js';

/** 分片大小 16KB */
const CHUNK_SIZE = 16384;
/** 发送暂停阈值 256KB */
const HIGH_WATER_MARK = 262144;
/** 发送恢复阈值 64KB */
const LOW_WATER_MARK = 65536;
/** 上传大小限制 1GB */
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;
/** 等待 Plugin 首条响应的超时（DC open + Plugin 回复首条控制消息） */
const READY_TIMEOUT_MS = 120_000;

/** 构造与 axios CanceledError 对齐的取消错误 */
function makeAbortError(message) {
	const err = new Error(message ?? 'request aborted');
	err.name = 'CanceledError';
	err.code = 'ERR_CANCELED';
	return err;
}

/**
 * 创建内部 AbortController 并挂外部 signal 联动
 * 外部 signal abort → 内部 ctrl.abort()
 * 若外部 signal 已 abort，ctrl 同步进入 aborted 状态
 * 返回 cleanup 方法，用于传输正常完成时解绑外部 signal 的 listener
 * @param {AbortSignal} [externalSignal]
 * @returns {{ ctrl: AbortController, cleanup: () => void }}
 */
function createLinkedAbortController(externalSignal) {
	const ctrl = new AbortController();
	let onExternalAbort = null;
	if (externalSignal) {
		if (externalSignal.aborted) {
			ctrl.abort();
		} else {
			onExternalAbort = () => ctrl.abort();
			externalSignal.addEventListener('abort', onExternalAbort, { once: true });
		}
	}
	return {
		ctrl,
		cleanup() {
			if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
		},
	};
}

/**
 * 格式化传输日志摘要（大小、耗时、速度）
 * @param {number} bytes - 传输字节数
 * @param {number} durationMs - 耗时（毫秒）
 * @returns {string}
 */
export function formatTransferLog(bytes, durationMs) {
	const size = formatFileSize(bytes);
	const sec = durationMs / 1000;
	if (durationMs <= 0) return `${size} in <1ms`;
	const speed = formatFileSize(Math.round(bytes / sec)) + '/s';
	return `${size} in ${sec.toFixed(2)}s (${speed})`;
}

// --- RPC 操作（走 rpc DataChannel） ---

/**
 * 列出目录内容（单层）
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path - 相对 workspace 的路径
 * @returns {Promise<{ files: { name: string, type: string, size: number, mtime: number }[] }>}
 */
export function listFiles(clawConn, agentId, path) {
	return clawConn.request('coclaw.files.list', { agentId, path }, { timeout: 60_000 });
}

/**
 * 删除文件或目录
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export function deleteFile(clawConn, agentId, path, opts) {
	const params = { agentId, path };
	if (opts?.force) params.force = true;
	return clawConn.request('coclaw.files.delete', params, { timeout: 60_000 });
}

/**
 * 创建目录（递归，类似 mkdir -p）。目录已存在时视为成功。
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<object>}
 */
export function mkdirFiles(clawConn, agentId, path) {
	return clawConn.request('coclaw.files.mkdir', { agentId, path }, { timeout: 60_000 });
}

/**
 * 创建空文件。文件���存在时返回 ALREADY_EXISTS 错误。
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<object>}
 */
export function createFile(clawConn, agentId, path) {
	return clawConn.request('coclaw.files.create', { agentId, path }, { timeout: 60_000 });
}

// --- 文件传输（走 file:<transferId> DataChannel） ---

/**
 * 创建 file DataChannel
 * @param {import('./webrtc-connection.js').WebRtcConnection} rtcConn
 * @returns {{ dc: RTCDataChannel, transferId: string, cleanup: () => void }}
 */
function createFileDC(rtcConn) {
	const transferId = crypto.randomUUID();
	const dc = rtcConn.createDataChannel(`file:${transferId}`, { ordered: true });
	if (!dc) {
		throw new FileTransferError('RTC_NOT_READY', 'WebRTC connection not available');
	}

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		try {
			if (dc.readyState === 'open' || dc.readyState === 'connecting') {
				dc.close();
			}
		} catch {}
	};

	return { dc, transferId, cleanup };
}

/**
 * 下载文件（自动等待连接就绪）
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - 可选取消信号；与 handle.cancel() 等价，任一触发都会终止传输
 * @returns {FileTransferHandle}
 */
export function downloadFile(clawConn, agentId, path, opts = {}) {
	let progressCb = null;
	const { ctrl, cleanup: cleanupLink } = createLinkedAbortController(opts.signal);
	const isCancelled = () => ctrl.signal.aborted;

	// 等待连接就绪（signal 透传，排队阶段也能立刻响应 abort）
	const readyPromise = clawConn.waitReady(DEFAULT_CONNECT_TIMEOUT_MS, ctrl.signal);

	const logCtx = `path=${path}`;

	const promise = readyPromise.then(() => new Promise((resolve, reject) => {
		// 等待就绪期间若已被取消，直接 reject（兜底：一般 waitReady 会先 reject 这里不进）
		if (isCancelled()) {
			cleanupLink();
			reject(makeAbortError('Download cancelled'));
			return;
		}

		let settled = false;
		let readyTimer = null;
		const startTime = Date.now();
		const settleWithLog = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			cleanupLink();
			if (fn === resolve) {
				const stats = formatTransferLog(val.bytes, Date.now() - startTime);
				console.log(`[file-transfer] download ok path=${path} ${stats}`);
			} else {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
				console.log(`[file-transfer] download fail path=${path} code=${val?.code ?? 'UNKNOWN'} elapsed=${elapsed}s`);
			}
			fn(val);
		};

		let dcRef, cleanupRef;
		try {
			const { dc, cleanup } = createFileDC(clawConn.rtc);
			dcRef = dc;
			cleanupRef = cleanup;
		} catch (err) {
			remoteLog(`file.dl.err code=RTC_NOT_READY ${logCtx} err=${err?.message}`);
			cleanupLink();
			reject(err);
			return;
		}

		// 挂 abort listener：DC 阶段 abort → 关 DC + reject ERR_CANCELED
		const onAbort = () => {
			clearTimeout(readyTimer);
			cleanupRef();
			settleWithLog(reject, makeAbortError('Download cancelled'));
		};
		ctrl.signal.addEventListener('abort', onAbort, { once: true });

		let totalSize = 0;
		let fileName = '';
		let receivedBytes = 0;
		let headerReceived = false;
		const chunks = [];

		console.log(`[file-transfer] download start path=${path}`);
		remoteLog(`file.dl.start ${logCtx}`);

		// 超时守卫：DC open + Plugin 响应头必须在限时内到达
		readyTimer = setTimeout(() => {
			if (headerReceived || isCancelled() || settled) return;
			cleanupRef();
			const ftErr = new FileTransferError('READY_TIMEOUT', 'Plugin did not respond in time');
			remoteLog(`file.dl.err code=${ftErr.code} ${logCtx}`);
			settleWithLog(reject, ftErr);
		}, READY_TIMEOUT_MS);

		dcRef.onopen = () => {
			try {
				dcRef.send(JSON.stringify({ method: 'GET', agentId, path }));
			} catch (err) {
				cleanupRef();
				const ftErr = new FileTransferError('DC_ERROR', 'Failed to send download request');
				remoteLog(`file.dl.err code=${ftErr.code} ${logCtx} err=${err?.message}`);
				settleWithLog(reject, ftErr);
			}
		};

		dcRef.onmessage = (event) => {
			if (isCancelled() || settled) return;

			if (typeof event.data === 'string') {
				let msg;
				try { msg = JSON.parse(event.data); }
				catch { return; }

				if (msg.ok === false) {
					cleanupRef();
					const ftErr = new FileTransferError(
						msg.error?.code ?? 'TRANSFER_FAILED',
						msg.error?.message ?? 'Download failed',
					);
					remoteLog(`file.dl.err code=${ftErr.code} ${logCtx} err=${ftErr.message}`);
					settleWithLog(reject, ftErr);
					return;
				}

				if (!headerReceived) {
					// 响应头：{ ok: true, size, name }
					headerReceived = true;
					clearTimeout(readyTimer);
					totalSize = msg.size ?? 0;
					fileName = msg.name ?? '';
					return;
				}

				// 完成确认：{ ok: true, bytes }
				if (msg.ok === true) {
					cleanupRef();
					const blob = new Blob(chunks);
					blob.name = fileName;
					settleWithLog(resolve, { blob, bytes: receivedBytes, name: fileName });
				}
			} else {
				// binary chunk
				// binaryType 正常为 'arraybuffer' 时 event.data 是 ArrayBuffer（.byteLength）；
				// 保留 .size fallback 以防未来某条路径漏设 binaryType，event.data 退化为 Blob，
				// 不让账本再度变成 NaN —— 否则 onclose 兜底里的 receivedBytes >= totalSize 会恒 false。
				chunks.push(event.data);
				receivedBytes += event.data.byteLength ?? event.data.size ?? 0;
				if (progressCb && totalSize > 0) {
					progressCb(receivedBytes, totalSize);
				}
			}
		};

		dcRef.onclose = () => {
			// 延迟一个 macrotask，让可能排队中的 onmessage 先执行
			// （WebRTC 某些实现中 close 和最后一条 message 可能几乎同时排入事件队列）
			setTimeout(() => {
				if (isCancelled() || settled) return;
				// 注销事件监听，释放 dcRef 引用，避免阻碍 GC
				cleanupRef();
				// 如果已收完所有字节，视为正常完成（完成确认 string 可能因 close 时序丢失）
				if (headerReceived && receivedBytes >= totalSize) {
					const blob = new Blob(chunks);
					blob.name = fileName;
					settleWithLog(resolve, { blob, bytes: receivedBytes, name: fileName });
					return;
				}
				const ftErr = new FileTransferError('TRANSFER_INTERRUPTED', 'Download interrupted');
				remoteLog(`file.dl.err code=${ftErr.code} ${logCtx} received=${receivedBytes}/${totalSize}`);
				settleWithLog(reject, ftErr);
			}, 0);
		};

		dcRef.onerror = () => {
			cleanupRef();
			const ftErr = new FileTransferError('DC_ERROR', 'DataChannel error during download');
			remoteLog(`file.dl.err code=${ftErr.code} ${logCtx} received=${receivedBytes}/${totalSize}`);
			settleWithLog(reject, ftErr);
		};
	})).catch((err) => {
		cleanupLink();
		throw err;
	});

	return {
		promise,
		cancel() { if (!ctrl.signal.aborted) ctrl.abort(); },
		set onProgress(cb) { progressCb = cb; },
	};
}

/**
 * 上传文件到指定路径（PUT 语义，客户端决定存储路径，自动等待连接就绪）
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path - 具体文件路径
 * @param {File|Blob} file
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {FileTransferHandle}
 */
export function uploadFile(clawConn, agentId, path, file, opts = {}) {
	return __doUpload(clawConn, file, {
		method: 'PUT', agentId, path, size: file.size,
	}, opts);
}

/**
 * 上传文件到集合路径（POST 语义，Plugin 决定最终路径，自动等待连接就绪）
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {string} agentId
 * @param {string} path - 集合目录路径
 * @param {string} fileName - 原始文件名
 * @param {File|Blob} file
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {FileTransferHandle} resolve 时额外包含 path 字段（实际存储路径）
 */
export function postFile(clawConn, agentId, path, fileName, file, opts = {}) {
	return __doUpload(clawConn, file, {
		method: 'POST', agentId, path, fileName, size: file.size,
	}, opts);
}

/**
 * 上传内部实现（PUT / POST 共用）
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {File|Blob} file
 * @param {object} reqMsg - 发送到 DC 的请求 JSON（含 method/agentId/path/size 等）
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {FileTransferHandle}
 */
function __doUpload(clawConn, file, reqMsg, opts = {}) {
	if (file.size > MAX_UPLOAD_SIZE) {
		const err = new FileTransferError(
			'SIZE_EXCEEDED',
			`File size ${file.size} exceeds limit ${MAX_UPLOAD_SIZE}`,
		);
		const p = Promise.reject(err);
		p.catch(() => {}); // 防止 unhandled rejection
		return { promise: p, cancel() {}, set onProgress(_cb) {} };
	}

	let progressCb = null;
	const { ctrl, cleanup: cleanupLink } = createLinkedAbortController(opts.signal);
	const isCancelled = () => ctrl.signal.aborted;

	const fileSize = file.size;
	const logCtx = `method=${reqMsg.method} size=${fileSize}`;

	// 等待连接就绪（signal 透传，排队阶段也能立刻响应 abort）
	const readyPromise = clawConn.waitReady(DEFAULT_CONNECT_TIMEOUT_MS, ctrl.signal);

	const promise = readyPromise.then(() => new Promise((resolve, reject) => {
		if (isCancelled()) {
			cleanupLink();
			reject(makeAbortError('Upload cancelled'));
			return;
		}

		let settled = false;
		let readyTimer = null;
		const startTime = Date.now();
		const uploadPath = reqMsg.fileName ? `${reqMsg.path}/${reqMsg.fileName}` : reqMsg.path;
		const settleWithLog = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			cleanupLink();
			if (fn === resolve) {
				const stats = formatTransferLog(val.bytes, Date.now() - startTime);
				console.log(`[file-transfer] upload ok path=${uploadPath} ${stats}`);
			} else {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
				console.log(`[file-transfer] upload fail path=${uploadPath} code=${val?.code ?? 'UNKNOWN'} elapsed=${elapsed}s`);
			}
			fn(val);
		};

		let dcRef, cleanupRef;
		try {
			const { dc, cleanup } = createFileDC(clawConn.rtc);
			dcRef = dc;
			cleanupRef = cleanup;
		} catch (err) {
			remoteLog(`file.up.err code=RTC_NOT_READY ${logCtx} err=${err?.message}`);
			cleanupLink();
			reject(err);
			return;
		}

		let readyReceived = false;
		let sentBytes = 0;

		const onAbort = () => {
			clearTimeout(readyTimer);
			cleanupRef();
			settleWithLog(reject, makeAbortError('Upload cancelled'));
		};
		ctrl.signal.addEventListener('abort', onAbort, { once: true });

		console.log(`[file-transfer] upload start path=${uploadPath} size=${formatFileSize(fileSize)}`);
		remoteLog(`file.up.start ${logCtx}`);

		// 超时守卫：DC open + Plugin ready 信号必须在限时内到达
		readyTimer = setTimeout(() => {
			if (readyReceived || isCancelled() || settled) return;
			cleanupRef();
			const ftErr = new FileTransferError('READY_TIMEOUT', 'Plugin did not respond in time');
			remoteLog(`file.up.err code=${ftErr.code} ${logCtx}`);
			settleWithLog(reject, ftErr);
		}, READY_TIMEOUT_MS);

		dcRef.onopen = () => {
			try {
				dcRef.send(JSON.stringify(reqMsg));
			} catch (err) {
				cleanupRef();
				const ftErr = new FileTransferError('DC_ERROR', 'Failed to send upload request');
				remoteLog(`file.up.err code=${ftErr.code} ${logCtx} err=${err?.message}`);
				settleWithLog(reject, ftErr);
			}
		};

		dcRef.onmessage = (event) => {
			if (isCancelled() || settled) return;
			if (typeof event.data !== 'string') return;

			let msg;
			try { msg = JSON.parse(event.data); }
			catch { return; }

			if (msg.ok === false) {
				cleanupRef();
				const ftErr = new FileTransferError(
					msg.error?.code ?? 'TRANSFER_FAILED',
					msg.error?.message ?? 'Upload failed',
				);
				remoteLog(`file.up.err code=${ftErr.code} ${logCtx} err=${ftErr.message}`);
				settleWithLog(reject, ftErr);
				return;
			}

			if (!readyReceived) {
				// Plugin 准备就绪：{ ok: true }
				readyReceived = true;
				clearTimeout(readyTimer);
				sendChunks(dcRef, file, (b) => { sentBytes = b; }, () => progressCb, () => isCancelled() || settled).then(() => {
					if (isCancelled() || settled) return;
					// 发送完成信号
					try {
						dcRef.send(JSON.stringify({ done: true, bytes: fileSize }));
					} catch (err) {
						cleanupRef();
						const ftErr = new FileTransferError('DC_ERROR', 'Failed to send done signal');
						remoteLog(`file.up.err code=${ftErr.code} ${logCtx} sent=${sentBytes}/${fileSize} err=${err?.message}`);
						settleWithLog(reject, ftErr);
					}
				}).catch((err) => {
					if (isCancelled() || settled) return;
					cleanupRef();
					const code = err?.code ?? 'UNKNOWN';
					remoteLog(`file.up.err code=${code} ${logCtx} sent=${sentBytes}/${fileSize} err=${err?.message}`);
					settleWithLog(reject, err);
				});
				return;
			}

			// 写入结果：{ ok: true, bytes, path? }
			if (msg.ok === true) {
				cleanupRef();
				const result = { bytes: msg.bytes ?? fileSize };
				if (msg.path) result.path = msg.path;
				settleWithLog(resolve, result);
			}
		};

		dcRef.onclose = () => {
			// DC 关闭后 bufferedAmount 恒为 0，需在此时立即捕获
			const buffered = dcRef.bufferedAmount ?? '?';
			// 与下载同理：延迟一个 macrotask，让可能排队中的 onmessage（写入结果）先执行
			setTimeout(() => {
				if (isCancelled() || settled) return;
				const ftErr = new FileTransferError('TRANSFER_INTERRUPTED', 'Upload interrupted');
				remoteLog(`file.up.err code=${ftErr.code} ${logCtx} sent=${sentBytes}/${fileSize} buffered=${buffered}`);
				settleWithLog(reject, ftErr);
			}, 0);
		};

		dcRef.onerror = () => {
			cleanupRef();
			const ftErr = new FileTransferError('DC_ERROR', 'DataChannel error during upload');
			remoteLog(`file.up.err code=${ftErr.code} ${logCtx} sent=${sentBytes}/${fileSize}`);
			settleWithLog(reject, ftErr);
		};
	})).catch((err) => {
		cleanupLink();
		throw err;
	});

	return {
		promise,
		cancel() { if (!ctrl.signal.aborted) ctrl.abort(); },
		set onProgress(cb) { progressCb = cb; },
	};
}

/**
 * 分片发送文件内容（含 backpressure 流控）
 * @param {RTCDataChannel} dc
 * @param {File|Blob} file
 * @param {(sentBytes: number) => void} onSent - 累计已发送字节回调（供外层日志使用）
 * @param {() => ((sent: number, total: number) => void)|null} getProgressCb - 取最新回调（上层可后设）
 * @param {() => boolean} isCancelled
 * @returns {Promise<void>}
 */
async function sendChunks(dc, file, onSent, getProgressCb, isCancelled) {
	const reader = file.stream().getReader();
	let sentBytes = 0;
	// reader 读出的 chunk 可能不是 CHUNK_SIZE，需内部切分
	let buf = null;
	let bufOff = 0;

	try {
		while (true) {
			if (isCancelled()) return;

			let chunk;
			if (buf) {
				const remaining = buf.byteLength - bufOff;
				if (remaining <= CHUNK_SIZE) {
					chunk = bufOff === 0 ? buf : buf.slice(bufOff);
					buf = null;
					bufOff = 0;
				} else {
					chunk = buf.slice(bufOff, bufOff + CHUNK_SIZE);
					bufOff += CHUNK_SIZE;
				}
			} else {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.byteLength <= CHUNK_SIZE) {
					chunk = value;
				} else {
					chunk = value.slice(0, CHUNK_SIZE);
					buf = value;
					bufOff = CHUNK_SIZE;
				}
			}

			try {
				dc.send(chunk);
			} catch (err) {
				throw new FileTransferError(
					'DC_SEND_FAILED',
					`dc.send failed at ${sentBytes}/${file.size}: ${err?.message}`,
				);
			}
			sentBytes += chunk.byteLength;
			onSent(sentBytes);
			const cb = getProgressCb();
			if (cb) cb(sentBytes, file.size);

			// backpressure ���控
			if (dc.bufferedAmount > HIGH_WATER_MARK) {
				await waitForBufferDrain(dc, isCancelled);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * 等待 DC 缓冲区降到低水位
 * @param {RTCDataChannel} dc
 * @param {() => boolean} isCancelled
 * @returns {Promise<void>}
 */
function waitForBufferDrain(dc, isCancelled) {
	return new Promise((resolve, reject) => {
		if (dc.readyState !== 'open') {
			reject(new FileTransferError('DC_CLOSED', 'DataChannel closed during flow control'));
			return;
		}
		dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

		let done = false;
		const cleanup = () => {
			dc.removeEventListener('bufferedamountlow', onLow);
			dc.removeEventListener('close', onClose);
		};
		const onLow = () => {
			if (done) return;
			done = true;
			cleanup();
			resolve();
		};
		const onClose = () => {
			if (done) return;
			done = true;
			cleanup();
			if (isCancelled()) { resolve(); return; }
			reject(new FileTransferError('DC_CLOSED', 'DataChannel closed during flow control'));
		};
		dc.addEventListener('bufferedamountlow', onLow);
		dc.addEventListener('close', onClose);
	});
}

// --- 错误类 ---

export class FileTransferError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.name = 'FileTransferError';
		this.code = code;
	}
}

/**
 * @typedef {object} FileTransferHandle
 * @property {Promise<object>} promise - 传输完成时 resolve
 * @property {() => void} cancel - 取消传输
 * @property {((sent: number, total: number) => void)} onProgress - 进度回调 setter
 */

// 导出常量供测试使用
export { CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK, MAX_UPLOAD_SIZE, READY_TIMEOUT_MS };
