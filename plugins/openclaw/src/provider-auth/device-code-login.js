/**
 * device-code-login.js —— 通用「设备码扫码登录」驱动的可复用零件（B1：驱动上游 run）
 *
 * 不复刻任何一家的登录流程，而是经 plugin-sdk 的 resolvePluginProviders 拿到 provider 自己的
 * device_code 登录方法，用一个「捕获型 prompter」的 ctx 去驱动它的 run(ctx)，跟随上游同步。
 * 适用于**任何**暴露了 kind==='device_code' auth 方法的 provider（codex / copilot / 以后新增的），
 * 不针对某一家硬编码。minimax-portal 例外（走自家 B2 复刻流，见 handlers.js 路由 + minimax-oauth.js）。
 *
 * 本模块只放**纯函数 + ctx 工厂**（无 I/O、无 respond / 落盘），编排与两阶段响应在 handlers.js。
 *
 * 关键事实（核实自 openclaw-repo，详见 docs/model-config-api.md § 6.16）：
 * - device_code 方法的 run(ctx) 是「纯输出 + 后台轮询、零用户实时输入」：先 prompter.note 亮出
 *   「URL + 码」，再内部轮询，拿到 token 才 resolve。故套得进 CoClaw 现有两阶段 RPC，无需多轮 prompt 管道。
 * - codex / copilot 的验证 note 用同一套模板（`URL: <url>` 行 + `Code: <code>` 行），一条正则通吃。
 *   抠不到也不报错——把 note 全文作为 rawText 交前端兜底（用户明确要求）。
 * - codex 失败时会再发一条含 docs URL 的「帮助 note」；copilot 首条 note 是无 URL 的前导语。
 *   故「是否验证 note」判定 = 含 URL 且非帮助/FAQ 文案，不能只看「第一条 note」。
 * - copilot 已登录会先 confirm「是否重登」→ 捕获型 prompter 答 true（强制走一遍登录拿码）。
 * - 输出型 prompter：text / select / multiselect / oauth.createVpsAwareHandlers 一旦被调即抛错
 *   （= 该方法需要交互/回环、本通道不支持），错误经 run reject 暴露。
 */

// note 里的 URL：取到空白 / 右括号为止
const URL_RE = /https?:\/\/[^\s)]+/;
// 帮助 / FAQ 类 note 也含 URL，但不是验证信息，必须排除
const HELP_NOTE_RE = /faq|help|trouble|docs\.openclaw/i;
// 设备码样式短码兜底（如 ABCD-1234），仅在没有 `Code:` 行时用
const DEVICE_CODE_RE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;

/**
 * 判断一条 note 文本是否「验证信息 note」（亮 URL+码 的那条）。
 * @param {string} text
 * @returns {boolean}
 */
export function isVerificationNote(text) {
	const t = String(text ?? '');
	if (!URL_RE.test(t)) return false;
	if (HELP_NOTE_RE.test(t)) return false;
	return true;
}

/**
 * 从验证 note 文本里尽力抠出结构化字段；抠不到的返回 null（绝不抛错）。
 *
 * URL：优先 `URL:` 行，回退首个 http(s) 链接。
 * Code：优先 `Code:` 行，回退设备码样式短码。
 *
 * @param {string} text
 * @returns {{ verificationUri: string|null, userCode: string|null }}
 */
export function extractVerification(text) {
	const t = String(text ?? '');
	let verificationUri = null;
	const urlLine = t.match(/^[ \t]*URL:[ \t]*(\S+)/im);
	if (urlLine) verificationUri = urlLine[1];
	else {
		const m = t.match(URL_RE);
		if (m) verificationUri = m[0];
	}
	let userCode = null;
	const codeLine = t.match(/^[ \t]*Code:[ \t]*(\S+)/im);
	if (codeLine) userCode = codeLine[1];
	else {
		const m = t.match(DEVICE_CODE_RE);
		if (m) userCode = m[0];
	}
	return { verificationUri, userCode };
}

/**
 * 在 resolvePluginProviders 结果里找指定 provider 的 device_code 登录方法。
 * @param {Array<{id:string, auth?:Array<{kind:string, run?:Function}>}>} providers
 * @param {string} providerId
 * @returns {{ id:string, run:Function }|null}
 */
export function findDeviceCodeMethod(providers, providerId) {
	const provider = (providers ?? []).find((p) => p?.id === providerId);
	if (!provider) return null;
	const method = (provider.auth ?? []).find(
		(m) => m?.kind === 'device_code' && typeof m.run === 'function',
	);
	return method ?? null;
}

/**
 * 造一个「捕获型」ProviderAuthContext 去驱动 run。
 *
 * note 转发给 onNote（验证信息从这里来）；progress 空操作；confirm 答 true（copilot 重登放行）；
 * 真交互（text / select / multiselect / 回环 handler）一旦被调即抛，标记为「需交互、不支持」。
 * isRemote=true（codex 据此跳过本地 openUrl）；openUrl 空操作（copilot 会无条件调，安全吞掉）。
 *
 * @param {object} args
 * @param {object} args.config - OpenClaw 运行时配置快照
 * @param {string} [args.agentDir] - 凭据目录（copilot 据此探测已有登录）
 * @param {(text:string, title?:string)=>void} args.onNote - 每条 note 的回调
 * @returns {object} ProviderAuthContext 形状
 */
export function makeDeviceCodeCtx({ config, agentDir, onNote }) {
	return {
		config: config ?? {},
		env: process.env,
		agentDir,
		prompter: {
			intro: async () => {},
			outro: async () => {},
			plain: async () => {},
			note: async (message, title) => { onNote(String(message ?? ''), title); },
			progress: () => ({ update() {}, stop() {} }),
			confirm: async () => true,
			text: async () => { throw new Error('device-code login requires no text input'); },
			select: async () => { throw new Error('device-code login requires no selection'); },
			multiselect: async () => { throw new Error('device-code login requires no multiselect'); },
		},
		runtime: { log: () => {}, error: () => {}, exit: () => {} },
		isRemote: true,
		openUrl: async () => {},
		oauth: {
			createVpsAwareHandlers: () => {
				throw new Error('device-code login does not support loopback handlers');
			},
		},
	};
}
