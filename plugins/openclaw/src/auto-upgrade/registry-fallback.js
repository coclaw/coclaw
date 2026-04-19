/**
 * registry-fallback.js — npm registry 反向兜底
 *
 * 升级首次失败（timeout/429/网络异常等）后，按当前用户的 registry 选反方向源
 * 再试一次：用户原本走 npmmirror 卡住时切到 npmjs；走 npmjs 卡住（如 IP 段被
 * 限流）时切到 npmmirror。两侧任一可用即能脱困。
 */
import { execFile as nodeExecFile } from 'node:child_process';

export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 读取当前 npm 默认 registry（继承用户 .npmrc 与 env）
 *
 * 失败 / 空字符串均回退到 npmjs URL；上层 pickFallbackRegistry 会据此选 npmmirror。
 * 即"npm 命令本身坏掉时盲选 npmmirror"——在 worker 这种"反正只重试一次"的场景下
 * 是合理代价。
 *
 * 调用方应优先传入 execFileFn 以避免在测试环境拉起真实 npm 进程。
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 */
export function getCurrentNpmRegistry(opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	/* c8 ignore next -- ?? fallback */
	const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise((resolve) => {
		doExecFile('npm', ['config', 'get', 'registry'], {
			timeout,
			shell: process.platform === 'win32',
		}, (err, stdout) => {
			if (err) { resolve(NPMJS_REGISTRY); return; }
			const raw = String(stdout).trim();
			resolve(raw || NPMJS_REGISTRY);
		});
	});
}

/**
 * 根据当前 registry 选反向兜底：
 * - 含 `npmmirror.com` → 切到 npmjs
 * - 其他（含 npmjs / cnpmjs.org / 自建 / 非字符串等异常输入） → 一律切到 npmmirror
 *
 * "反向"语义只严格区分 npmmirror，因为它是国内绝对主流；其他国内镜像（cnpmjs 等）
 * 当前直接切到 npmmirror（同方向但换实例），属于"换源"兜底而非真正反向，是有意为之
 * 的简化。
 * @param {string} current
 * @returns {string}
 */
export function pickFallbackRegistry(current) {
	if (typeof current === 'string' && /npmmirror\.com/i.test(current)) {
		return NPMJS_REGISTRY;
	}
	return NPMMIRROR_REGISTRY;
}
