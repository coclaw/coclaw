import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { remoteLog } from '../remote-log.js';

// --- 常量 ---

const CHUNK_SIZE = 16_384; // 16KB
const HIGH_WATER_MARK = 262_144; // 256KB
const LOW_WATER_MARK = 65_536; // 64KB
const MAX_UPLOAD_SIZE = 1_073_741_824; // 1GB
const FILE_DC_TIMEOUT_MS = 30_000; // DC 打开后 30s 内需收到请求
const TMP_CLEANUP_DELAY_MS = 60_000; // 启动后 60s 延迟清理
const TMP_FILE_PATTERN = /\.tmp\.[0-9a-f-]{36}$/;

// --- 路径安全校验 ---

/**
 * 校验 userPath 是否在 workspaceDir 沙箱内，返回解析后的绝对路径。
 * 校验内容：路径穿越、符号链接指向沙箱外、特殊文件类型。
 * @param {string} workspaceDir - workspace 绝对路径
 * @param {string} userPath - 用户提供的相对路径
 * @param {object} [deps] - 可注入依赖（测试用）
 * @returns {Promise<string>} 解析后的绝对路径
 */
export async function validatePath(workspaceDir, userPath, deps = {}) {
	const _lstat = deps.lstat ?? fsp.lstat;

	if (!userPath || typeof userPath !== 'string') {
		const err = new Error('Path is required');
		err.code = 'PATH_DENIED';
		throw err;
	}

	const resolved = nodePath.resolve(workspaceDir, userPath);

	// 路径穿越检查
	if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + nodePath.sep)) {
		const err = new Error(`Path traversal denied: ${userPath}`);
		err.code = 'PATH_DENIED';
		throw err;
	}

	// 符号链接 & 文件类型检查（仅对已存在的路径）
	let stat;
	try {
		stat = await _lstat(resolved);
	} catch (e) {
		// 路径不存在 — 对 write 场景合法，后续操作自行判断
		if (e.code === 'ENOENT') return resolved;
		throw e;
	}

	// 符号链接：检查实际目标是否在 workspace 内
	if (stat.isSymbolicLink()) {
		let realTarget;
		try {
			realTarget = await (deps.realpath ?? fsp.realpath)(resolved);
		} catch {
			const err = new Error(`Cannot resolve symlink: ${userPath}`);
			err.code = 'PATH_DENIED';
			throw err;
		}
		if (realTarget !== workspaceDir && !realTarget.startsWith(workspaceDir + nodePath.sep)) {
			const err = new Error(`Symlink target outside workspace: ${userPath}`);
			err.code = 'PATH_DENIED';
			throw err;
		}
	}

	// 仅允许普通文件和目录
	/* c8 ignore next 4 -- 特殊文件类型（socket/FIFO/device）在测试环境无法可靠构造 */
	if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
		const err = new Error(`Special file type denied: ${userPath}`);
		err.code = 'PATH_DENIED';
		throw err;
	}

	return resolved;
}

// --- File Handler 工厂 ---

/**
 * @param {object} opts
 * @param {function} opts.resolveWorkspace - (agentId) => Promise<string> 返回 workspace 绝对路径
 * @param {object} [opts.logger]
 * @param {object} [opts.deps] - 可注入依赖（测试用）
 */
export function createFileHandler({ resolveWorkspace, logger, deps = {} }) {
	/* c8 ignore next -- ?? fallback */
	const log = logger ?? console;
	const _lstat = deps.lstat ?? fsp.lstat;
	const _readdir = deps.readdir ?? fsp.readdir;
	const _unlink = deps.unlink ?? fsp.unlink;
	const _rmdir = deps.rmdir ?? fsp.rmdir;
	const _rm = deps.rm ?? fsp.rm;
	const _stat = deps.stat ?? fsp.stat;
	const _mkdir = deps.mkdir ?? fsp.mkdir;
	const _rename = deps.rename ?? fsp.rename;
	const _createReadStream = deps.createReadStream ?? fs.createReadStream;
	const _createWriteStream = deps.createWriteStream ?? fs.createWriteStream;
	const _realpath = deps.realpath ?? fsp.realpath;

	const pathDeps = { lstat: _lstat, realpath: _realpath };

	// --- RPC 处理（rpc DC 上的 coclaw.files.* 方法） ---

	/**
	 * 处理 rpc DC 上的 coclaw.files.* 请求
	 * @param {object} payload - { id, method, params }
	 * @param {function} sendFn - (responseObj) => void
	 */
	async function handleRpcRequest(payload, sendFn) {
		const { id, method, params } = payload;
		try {
			if (method === 'coclaw.files.list') {
				const result = await listFiles(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else if (method === 'coclaw.files.delete') {
				const result = await deleteFile(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else if (method === 'coclaw.files.mkdir') {
				const result = await mkdirOp(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else if (method === 'coclaw.files.create') {
				const result = await createFile(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else {
				sendFn({
					type: 'res', id, ok: false,
					error: { code: 'UNKNOWN_METHOD', message: `Unknown file method: ${method}` },
				});
			}
		} catch (err) {
			sendFn({
				type: 'res', id, ok: false,
				error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message },
			});
		}
	}

	async function listFiles(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path ?? ''; /* c8 ignore next -- ?? fallback */
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath || '.', pathDeps);

		let stat;
		try {
			stat = await _stat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				const err = new Error(`Directory not found: ${userPath || '.'}`);
				err.code = 'NOT_FOUND';
				throw err;
			}
			/* c8 ignore next 2 */
			throw e;
		}
		if (!stat.isDirectory()) {
			const err = new Error(`Not a directory: ${userPath}`);
			err.code = 'IS_DIRECTORY';
			throw err;
		}

		const entries = await _readdir(resolved, { withFileTypes: true });
		const files = [];
		for (const entry of entries) {
			// 跳过临时文件
			if (TMP_FILE_PATTERN.test(entry.name)) continue;

			let type;
			if (entry.isSymbolicLink()) type = 'symlink';
			else if (entry.isDirectory()) type = 'dir';
			else if (entry.isFile()) type = 'file';
			/* c8 ignore next */
			else continue; // 跳过特殊文件

			let size = 0;
			let mtime = 0;
			try {
				const s = await _lstat(nodePath.join(resolved, entry.name));
				size = s.size;
				mtime = s.mtimeMs;
			} catch {
				// 获取 stat 失败时，条目仍然返回但没有 size/mtime
			}
			files.push({ name: entry.name, type, size, mtime: Math.floor(mtime) });
		}

		return { files };
	}

	async function deleteFile(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path;
		if (!userPath) {
			const err = new Error('path is required');
			err.code = 'PATH_DENIED';
			throw err;
		}
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath, pathDeps);

		let stat;
		try {
			stat = await _lstat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				const err = new Error(`File not found: ${userPath}`);
				err.code = 'NOT_FOUND';
				throw err;
			}
			throw e;
		}
		if (stat.isDirectory()) {
			if (params?.force) {
				await _rm(resolved, { recursive: true, force: true });
			} else {
				try {
					await _rmdir(resolved);
				} catch (e) {
					if (e.code === 'ENOTEMPTY') {
						const err = new Error(`Directory not empty: ${userPath}`);
						err.code = 'NOT_EMPTY';
						throw err;
					}
					throw e;
				}
			}
		} else {
			await _unlink(resolved);
		}
		return {};
	}

	async function mkdirOp(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path;
		if (!userPath) {
			const err = new Error('path is required');
			err.code = 'PATH_DENIED';
			throw err;
		}
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath, pathDeps);
		await _mkdir(resolved, { recursive: true });
		return {};
	}

	async function createFile(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path;
		if (!userPath) {
			const err = new Error('path is required');
			err.code = 'PATH_DENIED';
			throw err;
		}
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath, pathDeps);

		// 检查文件是否已存在
		try {
			await _lstat(resolved);
			// 没抛异常说明存在
			const err = new Error(`File already exists: ${userPath}`);
			err.code = 'ALREADY_EXISTS';
			throw err;
		} catch (e) {
			if (e.code === 'ALREADY_EXISTS') throw e;
			if (e.code !== 'ENOENT') throw e;
			// ENOENT — 不存在，继续创建
		}

		// 确保父目录存在
		await _mkdir(nodePath.dirname(resolved), { recursive: true });
		await (deps.writeFile ?? fsp.writeFile)(resolved, '');
		return {};
	}

	/**
	 * 生成唯一文件名：<name>-<4hex>.<ext>，碰撞时重试
	 * @param {string} dir - 目标目录绝对路径
	 * @param {string} fileName - 原始文件名
	 * @returns {Promise<string>} 唯一文件名（仅文件名，非完整路径）
	 */
	async function generateUniqueName(dir, fileName) {
		const ext = nodePath.extname(fileName);
		const base = nodePath.basename(fileName, ext);
		const maxAttempts = 20;
		for (let i = 0; i < maxAttempts; i++) {
			const hex = randomBytes(2).toString('hex');
			const candidate = `${base}-${hex}${ext}`;
			try {
				await _lstat(nodePath.join(dir, candidate));
				// 存在 → 碰撞，重试
			} catch (e) {
				if (e.code === 'ENOENT') return candidate;
				/* c8 ignore next -- lstat 非 ENOENT 属罕见 IO 异常 */
				throw e;
			} /* c8 ignore next */
		}
		/* c8 ignore start -- 20 次均碰撞几乎不可能 */
		const err = new Error(`Cannot generate unique name for: ${fileName}`);
		err.code = 'WRITE_FAILED';
		throw err;
		/* c8 ignore stop */
	}

	// --- File DataChannel 处理 ---

	/**
	 * 处理 file:<transferId> DataChannel
	 * @param {object} dc - werift DataChannel
	 * @param {string} [connId] - 所属 PeerConnection 的连接 ID
	 */
	function handleFileChannel(dc, connId) {
		let requestTimer = setTimeout(() => {
			try {
				dc.send(JSON.stringify({
					ok: false,
					error: { code: 'TIMEOUT', message: 'No request received within 30s' },
				}));
			/* c8 ignore next */
			} catch { /* ignore */ }
			/* c8 ignore next */
			try { dc.close(); } catch { /* ignore */ }
		}, FILE_DC_TIMEOUT_MS);
		requestTimer.unref?.();

		// 早期 error 上报：保护 GET/PUT/POST 接管前的窗口期
		// 内部 handler 接管后会用更具上下文的 onerror 替换此处
		dc.onerror = (err) => {
			/* c8 ignore next -- ?? fallback for missing label/err.message */
			remoteLog(`file.dc.error conn=${connId} label=${dc.label ?? 'unknown'} stage=pre-request err=${err?.message ?? err}`);
		};

		let requestReceived = false;

		dc.onmessage = (event) => {
			// 只处理第一条 string 消息作为请求
			if (requestReceived) return;
			if (typeof event.data !== 'string') return;

			requestReceived = true;
			clearTimeout(requestTimer);
			requestTimer = null;

			let req;
			try {
				req = JSON.parse(event.data);
			} catch {
				sendError(dc, 'INVALID_INPUT', 'Invalid JSON request');
				return;
			}

			// 本地 logger.info：让 gateway 本地 log 直接看到 file 操作的开始
			// （远端诊断走 remoteLog，但本地能看到对排查 WSL2 假活/重连场景至关重要）
			log.info?.(`[coclaw/file] [${connId}] ${req.method} label=${dc.label ?? '?'} path=${req.path ?? '?'}${req.size != null ? ` size=${req.size}` : ''}`);

			if (req.method === 'GET') {
				/* c8 ignore next 3 -- handleGet 内部已完整处理异常，此 catch 纯防御 */
				handleGet(dc, req, connId).catch((err) => {
					log.warn?.(`[coclaw/file] GET error: ${err.message}`);
				});
			} else if (req.method === 'PUT') {
				/* c8 ignore next 3 -- handlePut 内部已完整处理异常，此 catch 纯防御 */
				handlePut(dc, req, connId).catch((err) => {
					log.warn?.(`[coclaw/file] PUT error: ${err.message}`);
				});
			} else if (req.method === 'POST') {
				/* c8 ignore next 3 -- handlePost 内部已完整处理异常，此 catch 纯防御 */
				handlePost(dc, req, connId).catch((err) => {
					log.warn?.(`[coclaw/file] POST error: ${err.message}`);
				});
			} else {
				sendError(dc, 'UNKNOWN_METHOD', `Unknown method: ${req.method}`);
			}
		};
	}

	async function handleGet(dc, req, connId) {
		/* c8 ignore next -- ?./?? fallback for non-file: label */
		const transferId = dc.label?.split(':')?.[1] ?? randomUUID();
		const logTag = connId ? `conn=${connId} ` : '';
		const startTime = Date.now();

		let workspaceDir, resolved;
		try {
			const agentId = req.agentId?.trim?.() || 'main'; /* c8 ignore next -- ?./?? fallback */
			workspaceDir = await resolveWorkspace(agentId);
			resolved = await validatePath(workspaceDir, req.path, pathDeps);
		} catch (err) {
			sendError(dc, err.code ?? 'INTERNAL_ERROR', err.message); /* c8 ignore next -- ?? fallback */
			return;
		}

		let stat;
		try {
			stat = await _stat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				sendError(dc, 'NOT_FOUND', `File not found: ${req.path}`);
			} else {
				sendError(dc, 'READ_FAILED', e.message);
			}
			return;
		}
		if (stat.isDirectory()) {
			sendError(dc, 'IS_DIRECTORY', `Cannot read a directory: ${req.path}`);
			return;
		}
		if (!stat.isFile()) {
			sendError(dc, 'PATH_DENIED', `Not a regular file: ${req.path}`);
			return;
		}

		// 发送响应头
		try {
			dc.send(JSON.stringify({
				ok: true,
				size: stat.size,
				name: nodePath.basename(resolved),
			}));
		} catch {
			return; // DC 已关闭
		}
		remoteLog(`file.dl.start ${logTag}id=${transferId} size=${stat.size}`);
		/* c8 ignore next -- 空文件分支：进度日志条件下永远不触发，无需 25% 阈值 */
		let nextLogAt = stat.size > 0 ? Math.floor(stat.size * 0.25) : Infinity;
		let logStep = 1;

		// 流式发送文件内容
		const stream = _createReadStream(resolved, { highWaterMark: CHUNK_SIZE });
		let sentBytes = 0;
		let dcClosed = false;

		// flow control 状态
		let bufferedAmountLowCount = 0;
		let pauseCount = 0;
		let resumeCount = 0;
		let pausedNow = false;

		dc.onclose = () => {
			dcClosed = true;
			stream.destroy();
		};

		// pion 异步 send 错误经此回调上报；ndc 同步抛错由 stream.on('data') 的 try/catch 接住
		dc.onerror = (err) => {
			if (dcClosed) return;
			dcClosed = true;
			stream.destroy();
			const elapsed = Date.now() - startTime;
			/* c8 ignore next -- ?? fallback for non-Error throw */
			const errMsg = err?.message ?? String(err);
			remoteLog(`file.dl.fail ${logTag}id=${transferId} reason=dc-error err=${errMsg} sent=${sentBytes}/${stat.size} elapsed=${elapsed}ms`);
			log.warn?.(`[coclaw/file] [${connId ?? '?'}] dl.fail id=${transferId} reason=dc-error sent=${sentBytes}/${stat.size} err=${errMsg}`);
		};

		if (dc.bufferedAmountLowThreshold !== undefined) {
			dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
		}
		dc.onbufferedamountlow = () => {
			bufferedAmountLowCount++;
			if (pausedNow) {
				resumeCount++;
				pausedNow = false;
				stream.resume();
			}
		};

		await new Promise((resolve, reject) => {
			stream.on('data', (chunk) => {
				if (dcClosed) { stream.destroy(); return; }
				try {
					dc.send(chunk);
					sentBytes += chunk.length;
					if (dc.bufferedAmount > HIGH_WATER_MARK) {
						pauseCount++;
						pausedNow = true;
						stream.pause();
					}
					// 进度日志（25% / 50% / 75%）
					if (sentBytes >= nextLogAt && logStep <= 3) {
						remoteLog(`file.dl.progress ${logTag}id=${transferId} ${logStep * 25}% sent=${sentBytes}/${stat.size}`);
						logStep++;
						/* c8 ignore next -- 空文件分支：进入此循环时 stat.size 必然 > 0 */
						nextLogAt = stat.size > 0 ? Math.floor(stat.size * logStep * 0.25) : Infinity;
					}
				/* c8 ignore start -- dc.send 抛异常属罕见竞态 */
				} catch {
					dcClosed = true;
					stream.destroy();
				}
				/* c8 ignore stop */
			});
			stream.on('end', async () => {
				if (dcClosed) { resolve(); return; }
				try {
					dc.send(JSON.stringify({ ok: true, bytes: sentBytes }));
					// 必须 await close()：pion-node 等价 W3C graceful close，
					// 否则在不支持 graceful 的实现上最后一条 ok JSON 会被丢弃
					await dc.close();
				} catch { /* ignore */ }
				const elapsed = Date.now() - startTime;
				// 完成时也 dump 一次最终统计，便于事后审计 backpressure 行为
				remoteLog(`file.dl.ok ${logTag}id=${transferId} bytes=${sentBytes} elapsed=${elapsed}ms balCount=${bufferedAmountLowCount} pauseCount=${pauseCount} resumeCount=${resumeCount}`);
				log.info?.(`[coclaw/file] [${connId ?? '?'}] dl.ok id=${transferId} bytes=${sentBytes} elapsed=${elapsed}ms balCount=${bufferedAmountLowCount} pauseCount=${pauseCount}`);
				resolve();
			});
			stream.on('error', (err) => {
				if (!dcClosed) {
					sendError(dc, 'READ_FAILED', err.message);
				}
				const elapsed = Date.now() - startTime;
				remoteLog(`file.dl.fail ${logTag}id=${transferId} reason=read-error err=${err.message} sent=${sentBytes}/${stat.size} elapsed=${elapsed}ms`);
				log.warn?.(`[coclaw/file] [${connId ?? '?'}] dl.fail id=${transferId} reason=read-error sent=${sentBytes}/${stat.size} err=${err.message}`);
				reject(err);
			});
		}).catch((err) => {
			log.warn?.(`[coclaw/file] read stream error: ${err.message}`);
		});
	}

	async function handlePut(dc, req, connId) {
		let workspaceDir, resolved;
		try {
			const agentId = req.agentId?.trim?.() || 'main';
			workspaceDir = await resolveWorkspace(agentId);
			resolved = await validatePath(workspaceDir, req.path, pathDeps);
		} catch (err) {
			sendError(dc, err.code ?? 'INTERNAL_ERROR', err.message);
			return;
		}
		await receiveUpload(dc, req, resolved, undefined, connId);
	}

	async function handlePost(dc, req, connId) {
		let workspaceDir, dirResolved;
		try {
			const agentId = req.agentId?.trim?.() || 'main';
			workspaceDir = await resolveWorkspace(agentId);
			dirResolved = await validatePath(workspaceDir, req.path || '.', pathDeps);
		} catch (err) {
			sendError(dc, err.code ?? 'INTERNAL_ERROR', err.message);
			return;
		}

		const fileName = req.fileName;
		if (!fileName || typeof fileName !== 'string') {
			sendError(dc, 'INVALID_INPUT', 'fileName is required for POST');
			return;
		}

		// 确保集合目录存在
		try {
			await _mkdir(dirResolved, { recursive: true });
		} catch (err) {
			sendError(dc, 'WRITE_FAILED', `Cannot create directory: ${err.message}`);
			return;
		}

		// 生成唯一文件名
		let uniqueName;
		try {
			uniqueName = await generateUniqueName(dirResolved, fileName);
		/* c8 ignore start -- generateUniqueName 内部已处理，此为防御 */
		} catch (err) {
			sendError(dc, err.code ?? 'WRITE_FAILED', err.message);
			return;
		}
		/* c8 ignore stop */

		const resolved = nodePath.join(dirResolved, uniqueName);
		// 计算相对于 workspace 的路径，作为响应中的 path
		const relativePath = nodePath.relative(workspaceDir, resolved);
		await receiveUpload(dc, req, resolved, relativePath, connId);
	}

	/**
	 * 共享上传接收逻辑（PUT/POST 复用）
	 * @param {object} dc - DataChannel
	 * @param {object} req - 请求对象（含 size）
	 * @param {string} resolved - 目标文件绝对路径
	 * @param {string} [relativePath] - POST 时附带的相对路径（响应中返回）
	 * @param {string} [connId] - 所属连接 ID
	 */
	async function receiveUpload(dc, req, resolved, relativePath, connId) {
		const declaredSize = req.size;
		if (!Number.isFinite(declaredSize) || declaredSize < 0) {
			sendError(dc, 'INVALID_INPUT', 'size must be a non-negative number');
			return;
		}
		if (declaredSize > MAX_UPLOAD_SIZE) {
			sendError(dc, 'SIZE_EXCEEDED', `File size ${declaredSize} exceeds 1GB limit`);
			return;
		}

		// 确保目标目录存在（PUT 场景需要；POST 已在上层创建，幂等无害）
		const targetDir = nodePath.dirname(resolved);
		try {
			await _mkdir(targetDir, { recursive: true });
		} catch (err) {
			sendError(dc, 'WRITE_FAILED', `Cannot create directory: ${err.message}`);
			return;
		}

		// 临时文件与目标在同一目录（避免 EXDEV）
		const transferId = dc.label?.split(':')?.[1] ?? randomUUID();
		const tmpPath = `${resolved}.tmp.${transferId}`;

		let ws;
		try {
			ws = _createWriteStream(tmpPath, { highWaterMark: CHUNK_SIZE });
		} catch (err) {
			sendError(dc, 'WRITE_FAILED', `Cannot create temp file: ${err.message}`);
			return;
		}

		const logTag = connId ? `conn=${connId} ` : '';
		remoteLog(`file.up.start ${logTag}id=${transferId} method=${req.method} size=${declaredSize}`);
		const startTime = Date.now();
		let nextLogAt = declaredSize > 0 ? Math.floor(declaredSize * 0.25) : Infinity;
		let logStep = 1; // 25% → 50% → 75%

		// 发送就绪信号
		try {
			dc.send(JSON.stringify({ ok: true }));
		} catch {
			// WriteStream 可能尚未完成文件创建，等 close 后再清理
			ws.on('close', () => safeUnlink(tmpPath));
			ws.destroy();
			remoteLog(`file.up.abort ${logTag}id=${transferId} reason=dc-send-failed`);
			return;
		}

		let receivedBytes = 0;
		let doneReceived = false;
		let dcClosed = false;
		let wsBackpressureCount = 0;
		let wsError = false;
		let finishing = false;

		// --- 受控写入：中间缓冲 + drain 循环 ---
		const pendingQueue = [];
		let draining = false;

		function scheduleDrain() {
			if (draining) return;
			draining = true;
			setImmediate(drainLoop);
		}

		function drainLoop() {
			if (wsError || dcClosed) { draining = false; return; }
			const chunk = pendingQueue.shift();
			if (!chunk) {
				draining = false;
				// 队列排空且已收到 done → 结束写入
				if (doneReceived) finishUpload();
				return;
			}
			let ok;
			try {
				ok = ws.write(chunk);
			} catch (err) {
				// ws 可能已被销毁（如 SIZE_EXCEEDED 路径竞态），防止 gateway 崩溃
				wsError = true;
				draining = false;
				pendingQueue.length = 0;
				log.warn?.(`[coclaw/file] drainLoop write error: ${err.message}`);
				ws.destroy();
				if (!dcClosed) sendError(dc, 'WRITE_FAILED', err.message);
				safeUnlink(tmpPath);
				const elapsed = Date.now() - startTime;
				remoteLog(`file.up.fail ${logTag}id=${transferId} reason=drain-write-error err=${err.message} received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms`);
				return;
			}
			if (!ok) {
				wsBackpressureCount++;
				// 等待 drain 事件后再继续（尊重磁盘 I/O 速度）
				ws.once('drain', () => setImmediate(drainLoop));
			} else {
				// 每次写入后让出 CPU，防止事件循环饥饿
				setImmediate(drainLoop);
			}
		}

		function finishUpload() {
			if (finishing) return;
			finishing = true;
			ws.end(async () => {
				const elapsed = Date.now() - startTime;
				if (dcClosed) {
					safeUnlink(tmpPath);
					remoteLog(`file.up.fail ${logTag}id=${transferId} reason=dc-closed-before-flush received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
					log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=dc-closed-before-flush received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
					return;
				}
				const valid = receivedBytes === declaredSize;
				if (!valid) {
					try {
						dc.send(JSON.stringify({ ok: false, error: { code: 'WRITE_FAILED', message: `Size mismatch: expected ${declaredSize}, got ${receivedBytes}` } }));
					/* c8 ignore next */
					} catch { /* ignore */ }
					safeUnlink(tmpPath);
					// graceful close：必须 await，否则 send 入队的 error JSON 会被 close 丢弃
					try { await dc.close(); } catch { /* ignore */ }
					remoteLog(`file.up.fail ${logTag}id=${transferId} reason=size-mismatch expected=${declaredSize} got=${receivedBytes} elapsed=${elapsed}ms`);
					log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=size-mismatch expected=${declaredSize} got=${receivedBytes} elapsed=${elapsed}ms`);
					return;
				}
				// 先 rename，再发成功响应（避免 rename 失败时 UI 误认为成功）
				try {
					await _rename(tmpPath, resolved);
				} catch (renameErr) {
					log.warn?.(`[coclaw/file] rename failed: ${renameErr.message}`);
					/* c8 ignore next 3 -- dc.send/close 失败属罕见竞态 */
					try {
						dc.send(JSON.stringify({ ok: false, error: { code: 'WRITE_FAILED', message: `rename failed: ${renameErr.message}` } }));
					} catch { /* ignore */ }
					safeUnlink(tmpPath);
					try { await dc.close(); } catch { /* ignore */ }
					remoteLog(`file.up.fail ${logTag}id=${transferId} reason=rename-failed received=${receivedBytes} elapsed=${elapsed}ms`);
					log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=rename-failed received=${receivedBytes} elapsed=${elapsed}ms`);
					return;
				}
				const result = { ok: true, bytes: receivedBytes };
				if (relativePath) result.path = relativePath;
				try {
					dc.send(JSON.stringify(result));
				/* c8 ignore next */
				} catch { /* ignore */ }
				// graceful close：上传成功路径同样必须 await，否则 result JSON 会丢
				try { await dc.close(); } catch { /* ignore */ }
				remoteLog(`file.up.ok ${logTag}id=${transferId} bytes=${receivedBytes} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
				log.info?.(`[coclaw/file] [${connId ?? '?'}] up.ok id=${transferId} bytes=${receivedBytes} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
			});
		}

		// 替换原始 onmessage（文件传输模式）
		dc.onmessage = (event) => {
			if (typeof event.data === 'string') {
				let msg;
				try { msg = JSON.parse(event.data); } catch { return; }
				if (msg.done) {
					doneReceived = true;
					// 队列已空则立即结束，否则等 drainLoop 排空后处理
					if (pendingQueue.length === 0 && !draining) finishUpload();
				}
			} else {
				// binary 数据帧 — 入队，由 drainLoop 按节奏写入
				const chunk = event.data;
				const len = chunk.byteLength ?? chunk.length ?? 0;
				receivedBytes += len;

				// 接收端超限防护
				if (receivedBytes > MAX_UPLOAD_SIZE || receivedBytes > declaredSize) {
					wsError = true;
					pendingQueue.length = 0;
					ws.destroy();
					safeUnlink(tmpPath);
					try {
						dc.send(JSON.stringify({
							ok: false,
							error: { code: 'SIZE_EXCEEDED', message: 'Received bytes exceed declared size or 1GB limit' },
						}));
					} catch { /* ignore */ }
					try { dc.close(); } catch { /* ignore */ }
					remoteLog(`file.up.reject ${logTag}id=${transferId} reason=size-exceeded received=${receivedBytes}`);
					log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.reject id=${transferId} reason=size-exceeded received=${receivedBytes}`);
					return;
				}

				pendingQueue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				scheduleDrain();

				// 进度日志（25% / 50% / 75%）
				if (receivedBytes >= nextLogAt && logStep <= 3) {
					remoteLog(`file.up.progress ${logTag}id=${transferId} ${logStep * 25}% received=${receivedBytes}/${declaredSize} bp=${wsBackpressureCount}`);
					logStep++;
					/* c8 ignore next -- declaredSize=0 的上传不会达到进度日志阈值 */
					nextLogAt = declaredSize > 0 ? Math.floor(declaredSize * logStep * 0.25) : Infinity;
				}
			}
		};

		dc.onclose = () => {
			dcClosed = true;
			draining = false;
			pendingQueue.length = 0;
			if (doneReceived) {
				// done 已收到但 drain 未完成 — finishUpload 中会检测 dcClosed 并清理 tmp
				if (!finishing) finishUpload();
			} else {
				ws.destroy();
				safeUnlink(tmpPath);
				const elapsed = Date.now() - startTime;
				remoteLog(`file.up.fail ${logTag}id=${transferId} reason=dc-closed received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
				log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=dc-closed received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
			}
		};

		// pion 异步 send 错误经此回调上报；触发已有清理路径
		dc.onerror = (err) => {
			if (dcClosed || wsError) return;
			wsError = true;
			draining = false;
			pendingQueue.length = 0;
			ws.destroy();
			safeUnlink(tmpPath);
			const elapsed = Date.now() - startTime;
			/* c8 ignore next -- ?? fallback for non-Error throw */
			const errMsg = err?.message ?? String(err);
			remoteLog(`file.up.fail ${logTag}id=${transferId} reason=dc-error err=${errMsg} received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms bp=${wsBackpressureCount}`);
			/* c8 ignore next -- ?./?? fallback */
			log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=dc-error received=${receivedBytes}/${declaredSize} err=${errMsg}`);
		};

		// WriteStream 错误处理
		ws.on('error', (err) => {
			// 幂等：dc.onerror 路径会先 ws.destroy()，destroy 可能再触发一次 'error'，
			// 已设 wsError 后直接返回，避免产生第二条 fail 日志
			if (wsError) return;
			wsError = true;
			draining = false;
			pendingQueue.length = 0;
			log.warn?.(`[coclaw/file] write stream error: ${err.message}`);
			if (!dcClosed) {
				const code = err.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED';
				sendError(dc, code, err.message);
			}
			safeUnlink(tmpPath);
			const elapsed = Date.now() - startTime;
			remoteLog(`file.up.fail ${logTag}id=${transferId} reason=write-error err=${err.code || err.message} received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms`);
			log.warn?.(`[coclaw/file] [${connId ?? '?'}] up.fail id=${transferId} reason=write-error received=${receivedBytes}/${declaredSize} elapsed=${elapsed}ms err=${err.code || err.message}`);
		});
	}

	// --- 临时文件清理 ---

	let cleanupTimer = null;

	/**
	 * 延迟启动临时文件清理任务
	 * @param {function} listAgentWorkspaces - () => Promise<string[]> 返回所有 workspace 路径
	 */
	function scheduleTmpCleanup(listAgentWorkspaces) {
		if (cleanupTimer) return;
		cleanupTimer = setTimeout(async () => {
			cleanupTimer = null;
			try {
				const workspaces = await listAgentWorkspaces();
				for (const dir of workspaces) {
					await cleanupTmpFilesInDir(dir);
				}
			} catch (err) {
				log.warn?.(`[coclaw/file] tmp cleanup failed: ${err.message}`);
			}
		}, TMP_CLEANUP_DELAY_MS);
		cleanupTimer.unref?.();
	}

	async function cleanupTmpFilesInDir(dir) {
		let entries;
		try {
			entries = await _readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isFile() && TMP_FILE_PATTERN.test(entry.name)) {
				safeUnlink(nodePath.join(dir, entry.name));
			}
			// 递归进入子目录
			if (entry.isDirectory()) {
				await cleanupTmpFilesInDir(nodePath.join(dir, entry.name));
			}
		}
	}

	function cancelCleanup() {
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			cleanupTimer = null;
		}
	}

	// --- 工具函数 ---

	function sendError(dc, code, message) {
		/* c8 ignore next 2 -- DC 可能已关闭，catch 纯防御 */
		try {
			dc.send(JSON.stringify({ ok: false, error: { code, message } }));
		} catch { /* DC 可能已关闭 */ }
		/* c8 ignore next */
		try { dc.close(); } catch { /* ignore */ }
	}

	function safeUnlink(filePath) {
		_unlink(filePath).catch(() => {});
	}

	return {
		handleRpcRequest,
		handleFileChannel,
		scheduleTmpCleanup,
		cancelCleanup,
		listFiles,
		deleteFile,
		mkdirOp,
		createFile,
		// 向后兼容（测试中已使用 __ 前缀）
		__listFiles: listFiles,
		__deleteFile: deleteFile,
		__mkdirOp: mkdirOp,
		__createFile: createFile,
		__handleGet: handleGet,
		__handlePut: handlePut,
		__handlePost: handlePost,
		__generateUniqueName: generateUniqueName,
		__cleanupTmpFilesInDir: cleanupTmpFilesInDir,
	};
}
