import { spawn as nodeSpawn } from 'node:child_process';

const NOTIFY_TIMEOUT_MS = 10_000;
const KILL_DELAY_MS = 2000;

/**
 * 通过 spawn 调用 `openclaw gateway call <method> --json`
 *
 * 背景：openclaw CLI 在完成 gateway RPC 后，因 WebSocket handle 未清理，
 * 进程不会自然退出。execSync 会一直阻塞直到超时，导致误报失败。
 *
 * 策略：
 * 1. spawn 子进程，监听 stdout
 * 2. 解析 JSON 输出判断 RPC 是否成功
 * 3. 检测到输出后延迟 KILL_DELAY_MS 再 kill（给进程自然退出的机会）
 * 4. 无论成功失败，最终都主动 kill 子进程
 *
 * @param {string} method - gateway method 名（如 coclaw.refreshBridge）
 * @param {Function} [spawnFn] - 可注入的 spawn 函数（测试用）
 * @param {object} [opts] - 可选配置（测试用）
 * @param {number} [opts.timeoutMs] - 总超时毫秒数
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
export function callGatewayMethod(method, spawnFn, opts) {
	const doSpawn = spawnFn ?? nodeSpawn;

	return new Promise((resolve) => {
		let child;
		try {
			child = doSpawn('openclaw', ['gateway', 'call', method, '--json'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch {
			resolve({ ok: false, error: 'spawn_failed' });
			return;
		}

		let stdout = '';
		let settled = false;
		let graceTimer = null;
		const killDelayMs = opts?.killDelayMs ?? KILL_DELAY_MS;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(graceTimer);
			try { child.kill(); } catch {} // eslint-disable-line no-empty
			resolve(result);
		};

		const parseResult = () => {
			const trimmed = stdout.trim();
			if (!trimmed) return { ok: false, error: 'empty_output' };
			try {
				const parsed = JSON.parse(trimmed);
				// openclaw gateway call --json 直接输出 method 的 result payload
				// 有合法 JSON 输出即视为 RPC 成功；失败时 CLI 会抛异常并以非零码退出
				return { ok: true, status: parsed.status };
			} catch {
				// 非 JSON 输出也视为成功（openclaw 非 --json 模式的兜底）
				return { ok: true };
			}
		};

		// 检测到完整 JSON 后，启动 grace 期等待进程自然退出
		const startGracePeriod = () => {
			if (graceTimer) return;
			const result = parseResult();
			graceTimer = setTimeout(() => finish(result), killDelayMs);
		};

		child.stdout.on('data', (chunk) => {
			stdout += String(chunk);
			const trimmed = stdout.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				startGracePeriod();
			}
		});

		child.stderr?.on('data', () => {});

		child.on('error', () => finish({ ok: false, error: 'spawn_error' }));

		// 进程自然退出：grace 期内退出则立即 resolve
		child.on('close', (code) => {
			if (code === 0 || stdout.trim()) {
				finish(parseResult());
			} else {
				finish({ ok: false, error: `exit_code_${code}` });
			}
		});

		const effectiveTimeout = opts?.timeoutMs ?? NOTIFY_TIMEOUT_MS;
		// 总超时：覆盖 gateway 不存在/重启中等场景
		const timeoutTimer = setTimeout(() => {
			if (stdout.trim()) {
				finish(parseResult());
			} else {
				finish({ ok: false, error: 'timeout' });
			}
		}, effectiveTimeout);
	});
}
