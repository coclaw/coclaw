/**
 * 文件传输服务（UI 侧）
 *
 * 基于 WebRTC DataChannel 实现 UI ↔ Plugin 的文件操作：
 * - list / delete / mkdir / create：走 rpc DataChannel（JSON-RPC）
 * - GET / PUT / POST：走独立 file:<transferId> DataChannel（自包含传输，HTTP 动词语义）
 *
 * 设计文档：docs/designs/file-management.md
 */

/** 分片大小 16KB */
const CHUNK_SIZE = 16384;
/** 发送暂停阈值 256KB */
const HIGH_WATER_MARK = 262144;
/** 发送恢复阈值 64KB */
const LOW_WATER_MARK = 65536;
/** 上传大小限制 1GB */
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;
/** 等待 Plugin ready 信号的超时（DC open + Plugin 回复 { ok: true }） */
const UPLOAD_READY_TIMEOUT_MS = 15_000;

// --- RPC 操作（走 rpc DataChannel） ---

/**
 * 列出目录内容（单层）
 * @param {import('./bot-connection.js').BotConnection} botConn
 * @param {string} agentId
 * @param {string} path - 相对 workspace 的路径
 * @returns {Promise<{ files: { name: string, type: string, size: number, mtime: number }[] }>}
 */
export function listFiles(botConn, agentId, path) {
	return botConn.request('coclaw.files.list', { agentId, path });
}

/**
 * 删除文件或目录
 * @param {import('./bot-connection.js').BotConnection} botConn
 * @param {string} agentId
 * @param {string} path
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export function deleteFile(botConn, agentId, path, opts) {
	const params = { agentId, path };
	if (opts?.force) params.force = true;
	return botConn.request('coclaw.files.delete', params);
}

/**
 * 创建目录（递归，类似 mkdir -p）。目录已存在时视为成功。
 * @param {import('./bot-connection.js').BotConnection} botConn
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<object>}
 */
export function mkdirFiles(botConn, agentId, path) {
	return botConn.request('coclaw.files.mkdir', { agentId, path });
}

/**
 * 创建空文件。文件已存在时返回 ALREADY_EXISTS 错误。
 * @param {import('./bot-connection.js').BotConnection} botConn
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<object>}
 */
export function createFile(botConn, agentId, path) {
	return botConn.request('coclaw.files.create', { agentId, path });
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
 * 下载文件
 * @param {import('./webrtc-connection.js').WebRtcConnection} rtcConn
 * @param {string} agentId
 * @param {string} path
 * @returns {FileTransferHandle}
 */
export function downloadFile(rtcConn, agentId, path) {
	let progressCb = null;
	let cancelled = false;
	let cancelFn = null;

	const promise = new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn, val) => {
			if (settled) return;
			settled = true;
			fn(val);
		};

		let dcRef, cleanupRef;
		try {
			const { dc, cleanup } = createFileDC(rtcConn);
			dcRef = dc;
			cleanupRef = cleanup;
		} catch (err) {
			reject(err);
			return;
		}

		cancelFn = () => {
			cancelled = true;
			cleanupRef();
			settle(reject, new FileTransferError('CANCELLED', 'Download cancelled'));
		};

		let totalSize = 0;
		let fileName = '';
		let receivedBytes = 0;
		let headerReceived = false;
		const chunks = [];

		dcRef.onopen = () => {
			try {
				dcRef.send(JSON.stringify({ method: 'GET', agentId, path }));
			} catch {
				cleanupRef();
				settle(reject, new FileTransferError('DC_ERROR', 'Failed to send download request'));
			}
		};

		dcRef.onmessage = (event) => {
			if (cancelled || settled) return;

			if (typeof event.data === 'string') {
				let msg;
				try { msg = JSON.parse(event.data); }
				catch { return; }

				if (msg.ok === false) {
					cleanupRef();
					settle(reject, new FileTransferError(
						msg.error?.code ?? 'TRANSFER_FAILED',
						msg.error?.message ?? 'Download failed',
					));
					return;
				}

				if (!headerReceived) {
					// 响应头：{ ok: true, size, name }
					headerReceived = true;
					totalSize = msg.size ?? 0;
					fileName = msg.name ?? '';
					return;
				}

				// 完成确认：{ ok: true, bytes }
				if (msg.ok === true) {
					cleanupRef();
					const blob = new Blob(chunks);
					blob.name = fileName;
					settle(resolve, { blob, bytes: receivedBytes, name: fileName });
				}
			} else {
				// binary chunk
				chunks.push(event.data);
				receivedBytes += event.data.byteLength;
				if (progressCb && totalSize > 0) {
					progressCb(receivedBytes, totalSize);
				}
			}
		};

		dcRef.onclose = () => {
			// 延迟一个 macrotask，让可能排队中的 onmessage 先执行
			// （WebRTC 某些实现中 close 和最后一条 message 可能几乎同时排入事件队列）
			setTimeout(() => {
				if (cancelled || settled) return;
				// 如果已收完所有字节，视为正常完成（完成确认 string 可能因 close 时序丢失）
				if (headerReceived && receivedBytes >= totalSize) {
					const blob = new Blob(chunks);
					blob.name = fileName;
					settle(resolve, { blob, bytes: receivedBytes, name: fileName });
					return;
				}
				settle(reject, new FileTransferError('TRANSFER_INTERRUPTED', 'Download interrupted'));
			}, 0);
		};

		dcRef.onerror = () => {
			cleanupRef();
			settle(reject, new FileTransferError('DC_ERROR', 'DataChannel error during download'));
		};
	});

	return {
		promise,
		cancel() { cancelFn?.(); },
		set onProgress(cb) { progressCb = cb; },
	};
}

/**
 * 上传文件到指定路径（PUT 语义，客户端决定存储路径）
 * @param {import('./webrtc-connection.js').WebRtcConnection} rtcConn
 * @param {string} agentId
 * @param {string} path - 具体文件路径
 * @param {File|Blob} file
 * @returns {FileTransferHandle}
 */
export function uploadFile(rtcConn, agentId, path, file) {
	return __doUpload(rtcConn, file, {
		method: 'PUT', agentId, path, size: file.size,
	});
}

/**
 * 上传文件到集合路径（POST 语义，Plugin 决定最终路径）
 * @param {import('./webrtc-connection.js').WebRtcConnection} rtcConn
 * @param {string} agentId
 * @param {string} path - 集合目录路径
 * @param {string} fileName - 原始文件名
 * @param {File|Blob} file
 * @returns {FileTransferHandle} resolve 时额外包含 path 字段（实际存储路径）
 */
export function postFile(rtcConn, agentId, path, fileName, file) {
	return __doUpload(rtcConn, file, {
		method: 'POST', agentId, path, fileName, size: file.size,
	});
}

/**
 * 上传内部实现（PUT / POST 共用）
 * @param {import('./webrtc-connection.js').WebRtcConnection} rtcConn
 * @param {File|Blob} file
 * @param {object} reqMsg - 发送到 DC 的请求 JSON（含 method/agentId/path/size 等）
 * @returns {FileTransferHandle}
 */
function __doUpload(rtcConn, file, reqMsg) {
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
	let cancelled = false;
	let cancelFn = null;

	const promise = new Promise((resolve, reject) => {
		let settled = false;
		let readyTimer = null;
		const settle = (fn, val) => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			fn(val);
		};

		let dcRef, cleanupRef;
		try {
			const { dc, cleanup } = createFileDC(rtcConn);
			dcRef = dc;
			cleanupRef = cleanup;
		} catch (err) {
			reject(err);
			return;
		}

		let readyReceived = false;

		cancelFn = () => {
			cancelled = true;
			clearTimeout(readyTimer);
			cleanupRef();
			settle(reject, new FileTransferError('CANCELLED', 'Upload cancelled'));
		};

		// 超时守卫：DC open + Plugin ready 信号必须在限时内到达
		readyTimer = setTimeout(() => {
			if (readyReceived || cancelled || settled) return;
			cleanupRef();
			settle(reject, new FileTransferError('READY_TIMEOUT', 'Plugin did not respond in time'));
		}, UPLOAD_READY_TIMEOUT_MS);

		dcRef.onopen = () => {
			try {
				dcRef.send(JSON.stringify(reqMsg));
			} catch {
				cleanupRef();
				settle(reject, new FileTransferError('DC_ERROR', 'Failed to send upload request'));
			}
		};

		dcRef.onmessage = (event) => {
			if (cancelled || settled) return;
			if (typeof event.data !== 'string') return;

			let msg;
			try { msg = JSON.parse(event.data); }
			catch { return; }

			if (msg.ok === false) {
				cleanupRef();
				settle(reject, new FileTransferError(
					msg.error?.code ?? 'TRANSFER_FAILED',
					msg.error?.message ?? 'Upload failed',
				));
				return;
			}

			if (!readyReceived) {
				// Plugin 准备就绪：{ ok: true }
				readyReceived = true;
				clearTimeout(readyTimer);
				sendChunks(dcRef, file, () => progressCb, () => cancelled || settled).then(() => {
					if (cancelled || settled) return;
					// 发送完成信号
					try {
						dcRef.send(JSON.stringify({ done: true, bytes: file.size }));
					} catch {
						cleanupRef();
						settle(reject, new FileTransferError('DC_ERROR', 'Failed to send done signal'));
					}
				}).catch((err) => {
					if (cancelled || settled) return;
					cleanupRef();
					settle(reject, err);
				});
				return;
			}

			// 写入结果：{ ok: true, bytes, path? }
			if (msg.ok === true) {
				cleanupRef();
				const result = { bytes: msg.bytes ?? file.size };
				if (msg.path) result.path = msg.path;
				settle(resolve, result);
			}
		};

		dcRef.onclose = () => {
			// 与下载同理：延迟一个 macrotask，让可能排队中的 onmessage（写入结果）先执行
			setTimeout(() => {
				if (cancelled || settled) return;
				settle(reject, new FileTransferError('TRANSFER_INTERRUPTED', 'Upload interrupted'));
			}, 0);
		};

		dcRef.onerror = () => {
			cleanupRef();
			settle(reject, new FileTransferError('DC_ERROR', 'DataChannel error during upload'));
		};
	});

	return {
		promise,
		cancel() { cancelFn?.(); },
		set onProgress(cb) { progressCb = cb; },
	};
}

/**
 * 分片发送文件内容（含 backpressure 流控）
 * @param {RTCDataChannel} dc
 * @param {File|Blob} file
 * @param {() => ((sent: number, total: number) => void)|null} getProgressCb - 取最新回调（上层可后设）
 * @param {() => boolean} isCancelled
 * @returns {Promise<void>}
 */
async function sendChunks(dc, file, getProgressCb, isCancelled) {
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

			dc.send(chunk);
			sentBytes += chunk.byteLength;
			const cb = getProgressCb();
			if (cb) cb(sentBytes, file.size);

			// backpressure 流控
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
export { CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK, MAX_UPLOAD_SIZE };
