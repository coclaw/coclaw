import { spawn as nodeSpawn } from 'node:child_process';

const NOTIFY_TIMEOUT_MS = 10_000;
const KILL_DELAY_MS = 2000;
const IS_WIN = process.platform === 'win32';

/**
 * Windows cmd.exe 下转义 JSON 字符串，使其作为单个参数传递
 * 双引号用 \" 转义，外层包裹双引号（与 cross-spawn 策略一致）
 */
export function escapeJsonForCmd(json) {
	return `"${json.replace(/"/g, '\\"')}"`;
}

/**
 * 通过 spawn 调用 `openclaw gateway call <method> --json`
 *
 * ## 设计背景
 *
 * openclaw CLI 完成 gateway RPC 后，因 GatewayClient（WebSocket）handle 未完全销毁，
 * 事件循环仍活跃，进程不会自然退出。早期使用 execSync 会阻塞等待进程退出而非输出完成，
 * 导致 RPC 实际在 ~2s 内成功，但 10s 超时后误报 100% 失败。
 *
 * ## 策略
 *
 * 1. spawn 子进程执行 `openclaw gateway call <method> --json`
 * 2. 监听 stdout，解析 JSON 输出判断 RPC 成功/失败
 * 3. 检测到完整 JSON 后启动 KILL_DELAY_MS grace period 等待自然退出
 * 4. 总超时默认 NOTIFY_TIMEOUT_MS（注册 CLI 路径覆盖为 30s）
 *    同时通过 `--timeout` 传递给子进程，确保内外层超时一致
 * 5. 无论成功失败，最终都主动 kill 子进程
 *
 * grace period 设计：openclaw 进程因 WS handle 滞留可能 10s+ 才退出，
 * 延迟 kill 是为兼容未来 OpenClaw 修复 WS 清理后进程能优雅退出的场景。
 *
 * ## stdout 判断策略
 *
 * `openclaw gateway call --json` 直接输出 method 的 result payload（respond 第二参数），
 * 而非 gateway 协议层 { ok, result, error } 包装：
 * - 有 stdout + 可解析 JSON → RPC 成功
 * - 有 stdout + 非 JSON → 也视为成功（兜底）
 * - 无 stdout + 非零退出码 → RPC 失败
 * - 无 stdout + 超时 → RPC 失败
 *
 * @param {string} method - gateway method 名（如 coclaw.bind）
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
			const isWin = opts?.isWin ?? IS_WIN;
			const args = ['gateway', 'call', method, '--json'];
			// 将超时传递给 openclaw gateway call（默认 10s），避免内外层超时不一致
			if (opts?.timeoutMs) {
				args.push('--timeout', String(opts.timeoutMs));
			}
			if (opts?.params) {
				const json = JSON.stringify(opts.params);
				// Windows 需 shell 解析 .cmd → 必须转义 JSON；非 Windows 不经 shell，直传
				args.push('--params', isWin ? escapeJsonForCmd(json) : json);
			}
			child = doSpawn('openclaw', args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: isWin, // 仅 Windows 需 shell 以解析 npm 全局安装的 .cmd
			});
		} catch {
			resolve({ ok: false, error: 'spawn_failed' });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let graceTimer = null;
		const killDelayMs = opts?.killDelayMs ?? KILL_DELAY_MS;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(graceTimer);
			try { child.kill(); } catch {}
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

		child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

		child.on('error', () => finish({ ok: false, error: 'spawn_error' }));

		// 进程自然退出：grace 期内退出则立即 resolve
		child.on('close', (code) => {
			if (code === 0 || stdout.trim()) {
				finish(parseResult());
			} else {
				const stderrMsg = stderr.trim();
				finish({ ok: false, error: `exit_code_${code}`, message: stderrMsg || undefined });
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
