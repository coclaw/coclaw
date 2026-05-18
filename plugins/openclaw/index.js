import { bindClaw, unbindClaw, enrollClaw, waitForClaimAndSave } from './src/common/claw-binding.js';
import { registerCoclawCli } from './src/cli-registrar.js';
import { resolveErrorMessage } from './src/common/errors.js';
import { notBound, bindOk, unbindOk, claimCodeCreated } from './src/common/messages.js';
import { coclawChannelPlugin } from './src/channel-plugin.js';
import { ensureAgentSession, gatewayAgentRpc, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady, broadcastPluginEvent } from './src/realtime-bridge.js';
import { getHostName, readSettings, writeName, MAX_NAME_LENGTH } from './src/settings.js';
import { readConfig } from './src/config.js';
import { setRuntime } from './src/runtime.js';
import { createSessionManager } from './src/session-manager/manager.js';
import { TopicManager } from './src/topic-manager/manager.js';
import { ChatHistoryManager } from './src/chat-history-manager/manager.js';
import { generateTitle } from './src/topic-manager/title-gen.js';
import { AutoUpgradeScheduler } from './src/auto-upgrade/updater.js';
import { getPackageInfo } from './src/auto-upgrade/updater-check.js';
import { createFileHandler } from './src/file-manager/handler.js';
import { abortAgentRun } from './src/agent-abort.js';
import { decideCancelResponse } from './src/agent-cancel-heuristic.js';
import { remoteLog } from './src/remote-log.js';
import { registerProviderAuthHandlers } from './src/provider-auth/index.js';
import { registerModelDefaultHandlers } from './src/model-default/index.js';

import { getPluginVersion, __resetPluginVersion } from './src/plugin-version.js';
export { getPluginVersion, __resetPluginVersion };

// 侧门注册表观测：patch OpenClaw embeddedRunState.activeRuns 的 set/delete，
// 用于跟踪 sessionId 何时注册/注销（agent 取消流程实际读取的就是这张表）。
// OpenClaw 侧门形状变化时（缺失 / 抛异常），通过 remoteLog 上报为升级契约变更的早期信号。
const PATCH_LABELS = [
	['embedded.activeRuns', () => globalThis[Symbol.for('openclaw.embeddedRunState')]?.activeRuns],
];

function installAbortRegistryDiag(logger) {
	const installed = [];
	const missing = [];
	try {
		for (const [label, resolve] of PATCH_LABELS) {
			if (patchMapLogging(resolve(), label, logger)) installed.push(label);
			else missing.push(label);
		}
	}
	catch (err) {
		logger?.warn?.(`[coclaw.diag] installAbortRegistryDiag failed: ${String(err?.message ?? err)}`);
		remoteLog(`abort.patch-failed reason=${String(err?.message ?? err)}`);
		return;
	}
	remoteLog(`abort.patch installed=${installed.join(',') || 'none'} missing=${missing.join(',') || 'none'}`);
}

function patchMapLogging(map, label, logger) {
	if (!map || typeof map.set !== 'function' || typeof map.delete !== 'function') return false;
	if (map.__coclawDiagPatched) return true;
	// 先打 idempotent 标记：若 map 是 frozen/sealed/Proxy 致 defineProperty 抛，
	// 立即返回 false 让上层归入 missing；不留下半装好的 wrapper 状态
	try {
		Object.defineProperty(map, '__coclawDiagPatched', { value: true, enumerable: false });
	}
	catch (err) {
		logger?.warn?.(`[coclaw.diag] cannot mark ${label} patched: ${String(err?.message ?? err)}`);
		return false;
	}
	const origSet = map.set.bind(map);
	const origDel = map.delete.bind(map);
	// log 行包 try/catch 兜底：上游若把 Map 换成有 throwing getter（如 Proxy）的对象，
	// 不能让本插件的诊断 log 把 OpenClaw 内部 set/delete 流程带崩
	const safeLog = (msg) => {
		try { logger?.info?.(msg); } catch { /* swallow — diag log 不得影响主流程 */ }
	};
	const safeSize = () => {
		try { return map.size; } catch { return '?'; }
	};
	map.set = (key, value) => {
		const res = origSet(key, value);
		safeLog(`[coclaw.diag] ${label}.set key=${stringifyKey(key)} size=${safeSize()}`);
		return res;
	};
	map.delete = (key) => {
		let had;
		try { had = map.has(key); } catch { had = '?'; }
		const res = origDel(key);
		safeLog(`[coclaw.diag] ${label}.delete key=${stringifyKey(key)} had=${had} size=${safeSize()}`);
		return res;
	};
	return true;
}

function stringifyKey(k) {
	if (typeof k === 'string') return k;
	try { return JSON.stringify(k); } catch { return String(k); }
}

/* c8 ignore start */
function parseCommandArgs(args) {
	const tokens = (args ?? '').split(/\s+/).filter(Boolean);
	const action = tokens[0] ?? 'help';
	const options = {};
	const positionals = [];

	for (let i = 1; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === '--server' && i + 1 < tokens.length) {
			options.server = tokens[i + 1];
			i += 1;
			continue;
		}
		positionals.push(token);
	}

	return { action, positionals, options };
}

function buildHelpText() {
	return [
		'CoClaw command:',
		'',
		'/coclaw bind <binding-code> [--server <url>]',
		'/coclaw unbind [--server <url>]',
		'/coclaw enroll [--server <url>]',
	].join('\n');
}

function respondError(respond, err) {
	respond(false, undefined, {
		code: err?.code ?? 'INTERNAL_ERROR',
		message: String(err?.message ?? err),
	});
}

function respondInvalid(respond, message) {
	respond(false, undefined, { code: 'INVALID_INPUT', message });
}
/* c8 ignore stop */

const plugin = {
	id: 'openclaw-coclaw',
	name: 'CoClaw',
	description: 'OpenClaw plugin for remote chat over WebRTC',
	register(api) {
		// 按 OpenClaw SDK 入口模式分叉（参照 defineChannelPluginEntry，见上游 plugin-sdk/core.ts 的
		// defineChannelPluginEntry 实现 与 docs/plugins/sdk-entrypoints.md）：
		// - cli-metadata 模式：仅声明根命令名供根 CLI 解析使用
		// - 其他模式：注册 channel + CLI 元信息（discovery 下两者由 captured-registration 采集）
		// - 仅 full 模式跑完整副作用（service / RPC / hook / command / managers / 磁盘 IO）
		//
		// 与上游 helper 的刻意偏差：上游 helper 在所有非 cli-metadata 模式下都调
		// setRuntime?.(api.runtime)，但 discovery 传入的 api.runtime 是空对象 {}，每 14s
		// 一次会把全局 runtime 单例擦掉。本实现把 setRuntime 严格限定在 full 模式，避免擦除。
		const mode = api.registrationMode;
		if (mode === 'cli-metadata') {
			api.registerCli(registerCoclawCli, { commands: ['coclaw'] });
			return;
		}
		api.registerChannel({ plugin: coclawChannelPlugin });
		api.registerCli(registerCoclawCli, { commands: ['coclaw'] });
		// 本插件 package.json 无 setupEntry，setup-only/setup-runtime 实际不会到达主 register；
		// 保留兜底防御上游模型变化。`mode !== 'full'` 也覆盖 discovery（每 14s 一次）
		if (mode !== 'full') return;

		/* c8 ignore start */
		setRuntime(api.runtime);
		const logger = api?.logger ?? console;
		installAbortRegistryDiag(logger);

		// 未 bind 时打条提示，便于 hub 装机用户看到下一步动作
		readConfig().then((cfg) => {
			if (!cfg?.token) {
				logger.info?.('[coclaw] not bound — run `openclaw coclaw enroll` to connect to CoClaw');
			}
		}).catch(() => {});
		const manager = createSessionManager({ logger });
		const topicManager = new TopicManager({ logger });
		const chatHistoryManager = new ChatHistoryManager({ logger });

		// 懒加载 topic / chat history 数据（best-effort，不阻断注册）
		topicManager.load('main').catch((err) => {
			logger.warn?.(`[coclaw] topic manager load failed: ${String(err?.message ?? err)}`);
		});
		chatHistoryManager.load('main').catch((err) => {
			logger.warn?.(`[coclaw] chat history manager load failed: ${String(err?.message ?? err)}`);
		});

		// 追踪 chat 因 reset 产生的 session 流水。双源回调（hook + sessions.changed）共用 helper。
		// recordSessionTransition 内部已 __reloadFromDisk + mutex，外层无需再 cache.has + load。
		//
		// agentId 解析：hook 路径有 ctx.agentId（显式契约，优先用）；sessions.changed 路径
		// gateway broadcast payload 不含 agentId（见 openclaw-repo emitSessionsChanged），
		// 只能 fallback 切 sessionKey（`agent:<agentId>:*` → parts[1]）。当前 sessionKey schema
		// 下两路径解析结果等价；多 agent topic 启用后若上游 sessionKey schema 加前缀会需复评。
		//
		// archivedSessionId 解析：hook 路径来自 event.resumedFrom；sessions.changed payload
		// 不带（无 previousSessionId 字段）→ 进 manager 时为 undefined。manager 不会去
		// "推断字段值"，而是把文件首位未归档头直接翻为归档（补 archivedAt）后再 unshift
		// 新头——等价于"以文件首位 sessionId 作为前任"。
		//
		// 该 helper 可直接作为 bridge.onSessionCreated 回调（签名兼容；缺失字段走兜底：
		// agentId 走 parts[1] fallback、archivedSessionId 走 manager 翻 head 路径）。
		async function handleSessionCreated({ agentId, sessionKey, sessionId, archivedSessionId }) {
			if (!sessionKey || !sessionId) {
				// 早返值得警惕：上游事件 schema 异常，或 topic（无 sessionKey）误入双源链路。
				// 打 log + remoteLog 让运维能定位事件源；不影响其他通道。
				logger.warn?.(
					`[coclaw] chat history early-return: missing sessionKey/sessionId`,
				);
				remoteLog(
					`chat-history.missing-keys sessionKey=${sessionKey ?? 'null'} sessionId=${sessionId ?? 'null'}`,
				);
				return;
			}
			// topic 上游伪造的 explicit fake sessionKey（形态 `agent:<agentId>:explicit:<sid>`）
			// 不属于 chat 流水范畴：CoClaw 自管 topic 元信息，不应进 chat-history 桶。
			// 当前 F1 实验已证明该路径不触发本回调，此守卫属防御性兜底。
			// 前提假设：(a) sessionKey 首段是 `agent`；(b) `explicit` 占第 3 段（即 parts[2]，
			// 0-indexed 数）。两条同时成立才命中本守卫；若上游 schema 演进（如挪位置 / 增前缀 /
			// 改首段名），需复评本守卫。
			const parts = sessionKey.split(':');
			if (parts[0] === 'agent' && parts[2] === 'explicit') {
				remoteLog(`chat-history.skip-explicit sessionKey=${sessionKey}`);
				return;
			}
			// subagent 是 OpenClaw 程序自起的子任务 run（mode=run 一次性 / mode=session 持久绑定），
			// 形态 `agent:<id>:subagent:<uuid>`，嵌套子代理为 `agent:<id>:subagent:<uuid>:subagent:<uuid2>`。
			// 它不是人机对话流；父 agent 的 transcript 里已含子代理最终输出（作为 user message 回流），
			// 因此不入 chat-history。
			// 判定从 parts[2] 起找 'subagent' 段，避免 agentId 恰好叫 'subagent' 时误伤。
			if (parts[0] === 'agent' && parts.indexOf('subagent', 2) >= 0) {
				remoteLog(`chat-history.skip-subagent sessionKey=${sessionKey}`);
				return;
			}
			let resolvedAgentId = agentId;
			if (!resolvedAgentId) {
				resolvedAgentId = (parts[0] === 'agent' && parts[1]) ? parts[1] : 'main';
			}
			try {
				await chatHistoryManager.recordSessionTransition({
					agentId: resolvedAgentId,
					sessionKey,
					currentSessionId: sessionId,
					archivedSessionId,
				});
			} catch (err) {
				logger.warn?.(`[coclaw] chat history record failed: ${String(err?.message ?? err)}`);
			}
		}
		if (typeof api.on === 'function') {
			api.on('session_start', async (event, ctx) => {
				// event.sessionId 是新 sid（必填），event.resumedFrom 是旧 sid（可选），ctx.agentId 可信
				await handleSessionCreated({
					agentId: ctx?.agentId,
					sessionKey: event?.sessionKey,
					sessionId: event?.sessionId,
					archivedSessionId: event?.resumedFrom,
				});
			});
		}

		// bridge 启动/重启的闭包 helper：把 onSessionCreated 接到 handleSessionCreated。
		// 所有 restartRealtimeBridge 调用必须走这个 helper，避免漏接回调。
		async function restartBridge() {
			await restartRealtimeBridge({
				logger,
				pluginConfig: api.pluginConfig,
				onSessionCreated: handleSessionCreated,
			});
		}

		api.registerService({
			id: 'coclaw-realtime-bridge',
			async start() {
				await restartBridge();
			},
			async stop() {
				await stopRealtimeBridge();
			},
		});

		// enroll 并发控制：同一时刻只允许一个活跃 enroll。
		// 声明前置以便 doBind/doUnbind 入口可调用 cancelActiveEnroll；
		// .finally 仍在 enroll 自身的回调里把 activeEnrollAbort 置 null。
		let activeEnrollAbort = null;

		function cancelActiveEnroll() {
			if (activeEnrollAbort) {
				logger.info?.('[coclaw] cancelling active enroll');
				activeEnrollAbort.abort();
				// 立即清 ref：避免后续 cancelActiveEnroll 对同一已 abort 的 controller 重复 log；
				// 原 enroll 自己的 .finally 仍负责本身分支的兜底清理（按 ref 相等判断）
				activeEnrollAbort = null;
			}
		}

		// --- bind/unbind 共享逻辑（RPC handler + 斜杠命令共用） ---

		async function doBind({ code, serverUrl }) {
			// 显式 bind 必须取消进行中的 enroll：否则 enroll 后到的 token 走 partial-failure
			// rollback 路径前可能仍写入旧 config，污染刚 bind 完的本地状态
			cancelActiveEnroll();
			await stopRealtimeBridge();
			let result;
			try {
				result = await bindClaw({
					code,
					serverUrl: serverUrl ?? api.pluginConfig?.serverUrl,
				});
			} catch (err) {
				// bind 失败时恢复 bridge（best-effort，不覆盖原始错误）
				await restartBridge().catch(() => {});
				throw err;
			}
			// bind 已持久化，restart 失败不影响结果
			await restartBridge().catch((err) => {
				logger.warn?.(`[coclaw] bridge restart failed after bind: ${err?.message ?? err}`);
			});
			return result;
		}

		async function doUnbind({ serverUrl }) {
			// unbind 同样取消进行中的 enroll，避免 server 解绑后 enroll token 又写回本地
			cancelActiveEnroll();
			const result = await unbindClaw({
				serverUrl: serverUrl ?? api.pluginConfig?.serverUrl,
			});
			await stopRealtimeBridge();
			return result;
		}

		api.registerGatewayMethod('coclaw.bind', async ({ params, respond }) => {
			try {
				const code = params?.code;
				if (typeof code !== 'string' || code.length === 0) {
					respondInvalid(respond, 'code must be a non-empty string');
					return;
				}
				if (params?.serverUrl !== undefined
					&& (typeof params.serverUrl !== 'string' || params.serverUrl.trim().length === 0)) {
					respondInvalid(respond, 'serverUrl must be a non-empty string');
					return;
				}
				const result = await doBind({
					code,
					serverUrl: params?.serverUrl,
				});
				respond(true, {
					clawId: result.clawId,
					rebound: result.rebound,
					previousClawId: result.previousClawId,
				});
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.unbind', async ({ params, respond }) => {
			try {
				if (params?.serverUrl !== undefined
					&& (typeof params.serverUrl !== 'string' || params.serverUrl.trim().length === 0)) {
					respondInvalid(respond, 'serverUrl must be a non-empty string');
					return;
				}
				const result = await doUnbind({ serverUrl: params?.serverUrl });
				respond(true, { clawId: result.clawId });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.enroll', async ({ params, respond }) => {
			try {
				if (params?.serverUrl !== undefined
					&& (typeof params.serverUrl !== 'string' || params.serverUrl.trim().length === 0)) {
					respondInvalid(respond, 'serverUrl must be a non-empty string');
					return;
				}
				// 取消前一个 enroll（与 doBind/doUnbind 共享 helper）
				cancelActiveEnroll();
				const abortController = new AbortController();
				activeEnrollAbort = abortController;

				const serverUrl = params?.serverUrl ?? api.pluginConfig?.serverUrl;
				const result = await enrollClaw({ serverUrl });

				const rawMinutes = Math.round(
					(new Date(result.expiresAt).getTime() - Date.now()) / 60_000,
				);
				const expiresMinutes = Number.isFinite(rawMinutes) ? rawMinutes : 30;

				// 立即返回认领码给 CLI
				respond(true, {
					code: result.code,
					appUrl: result.appUrl,
					expiresAt: result.expiresAt,
					expiresMinutes,
				});

				// 后台 fire-and-forget：等待认领并保存 config + 启 bridge
				waitForClaimAndSave({
					serverUrl: result.serverUrl,
					code: result.code,
					waitToken: result.waitToken,
					signal: abortController.signal,
				}).then(async () => {
					if (abortController.signal.aborted) return;
					await restartBridge();
					logger.info?.('[coclaw] enroll completed, bridge restarted');
				}).catch((err) => {
					if (abortController.signal.aborted) return;
					logger.warn?.(`[coclaw] enroll wait failed: ${String(err?.message ?? err)}`);
				}).finally(() => {
					if (activeEnrollAbort === abortController) {
						activeEnrollAbort = null;
					}
				});
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('nativeui.sessions.listAll', async ({ params, respond }) => {
			try {
				const agentId = params?.agentId?.trim?.() || 'main';
				// best-effort ensure：失败不阻断 listAll
				try { await ensureAgentSession(agentId); }
				catch {}
				respond(true, await manager.listAll(params ?? {}));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('nativeui.sessions.get', async ({ params, respond }) => {
			try {
				const sessionId = params?.sessionId;
				if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
					respondInvalid(respond, 'sessionId required');
					return;
				}
				respond(true, await manager.get(params ?? {}));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		async function handleInfoGet({ respond }) {
			try {
				await waitForSessionsReady();
				const version = await getPluginVersion();
				const rawClawVersion = api.runtime?.version;
				// OpenClaw 打包后 resolveVersion() 路径失配导致返回 'unknown'，此时不传该字段
				const clawVersion = (rawClawVersion && rawClawVersion !== 'unknown') ? rawClawVersion : undefined;
				const settings = await readSettings();
				const name = settings.name ?? null;
				const hostName = getHostName();
				respond(true, { version, clawVersion, capabilities: ['topics', 'chatHistory'], name, hostName });
			}
			catch (err) {
				respondError(respond, err);
			}
		}

		api.registerGatewayMethod('coclaw.info', handleInfoGet);
		api.registerGatewayMethod('coclaw.info.get', handleInfoGet);

		api.registerGatewayMethod('coclaw.info.patch', async ({ params, respond }) => {
			try {
				const rawName = params?.name;
				if (rawName === undefined) {
					respondInvalid(respond, 'name field is required');
					return;
				}
				if (rawName !== null && typeof rawName !== 'string') {
					respondInvalid(respond, 'name must be a string or null');
					return;
				}
				const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
				if (trimmed.length > MAX_NAME_LENGTH) {
					respondInvalid(respond, `name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
					return;
				}
				const nameToSave = trimmed || null;
				await writeName(nameToSave);
				const hostName = getHostName();
				respond(true, { name: nameToSave, hostName });
				// 仅广播本次 patch 涉及的字段；server 端按 patch 语义仅更新 payload 中出现的列
				broadcastPluginEvent('coclaw.info.updated', { name: nameToSave, hostName });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.create', async ({ params, respond }) => {
			try {
				const agentId = params?.agentId?.trim?.() || 'main';
				// 确保该 agent 的 topics 已加载
				if (!topicManager.__cache.has(agentId)) {
					await topicManager.load(agentId);
				}
				const result = await topicManager.create({ agentId });
				respond(true, result);
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.list', async ({ params, respond }) => {
			try {
				const agentId = params?.agentId?.trim?.() || 'main';
				if (!topicManager.__cache.has(agentId)) {
					await topicManager.load(agentId);
				}
				respond(true, topicManager.list({ agentId }));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.get', ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				respond(true, topicManager.get({ topicId }));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.getHistory', async ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				const agentId = params?.agentId?.trim?.() || 'main';
				// 直接复用 session-manager 的 get()，topicId 即 sessionId
				respond(true, await manager.get({ agentId, sessionId: topicId }));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.update', async ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				const changes = params?.changes;
				if (!changes || typeof changes !== 'object') {
					respondInvalid(respond, 'changes required');
					return;
				}
				// 当前版本仅处理 title
				if (typeof changes.title !== 'string') {
					respondInvalid(respond, 'No valid change field provided (supported: title)');
					return;
				}
				// 先检查 topic 是否存在：避免 updateTitle 内部 throw 后被 respondError 错报为 INTERNAL_ERROR
				const existing = topicManager.get({ topicId })?.topic;
				if (!existing) {
					respond(false, undefined, { code: 'NOT_FOUND', message: `Topic not found: ${topicId}` });
					return;
				}
				await topicManager.updateTitle({ topicId, title: changes.title });
				const { topic } = topicManager.get({ topicId });
				respond(true, { topic });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.generateTitle', async ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				const result = await generateTitle({
					topicId,
					topicManager,
					agentRpc: gatewayAgentRpc,
					logger,
				});
				respond(true, result);
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.topics.delete', async ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				const result = await topicManager.delete({ topicId });
				respond(true, result);
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.chatHistory.list', async ({ params, respond }) => {
			try {
				const agentId = params?.agentId?.trim?.() || 'main';
				const sessionKey = params?.sessionKey?.trim?.();
				if (!sessionKey) {
					respondInvalid(respond, 'sessionKey required');
					return;
				}
				if (!chatHistoryManager.__cache.has(agentId)) {
					await chatHistoryManager.load(agentId);
				}
				const result = await chatHistoryManager.list({ agentId, sessionKey });
				respond(true, result);
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		// TODO: coclaw.topics.getHistory 未来可废弃，UI 改用 coclaw.sessions.getById
		api.registerGatewayMethod('coclaw.sessions.getById', async ({ params, respond }) => {
			try {
				const sessionId = params?.sessionId?.trim?.();
				if (!sessionId) {
					respondInvalid(respond, 'sessionId required');
					return;
				}
				const agentId = params?.agentId?.trim?.() || 'main';
				const limit = params?.limit;
				respond(true, await manager.getById({ agentId, sessionId, limit }));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		// 取消正在执行的 embedded agent run（通过 OpenClaw 全局 symbol 侧门）
		// 侧门不存在 / sessionId 未注册 / handle.abort 抛异常时返回 { ok:false, reason } —— UI 静默降级
		// UI 可能在 OpenClaw 注册 sessionId 前点 STOP（注册空窗期），此时返回 not-found；UI 会按 500ms 间隔重试。
		// UI 自 v0.20 起额外透传 runDuration / abortDuration（墙钟差，毫秒）供启发判定：
		// 侧门返 not-found 但双闸都达阈值时升格为 gone，告知 UI 主动收尾。旧 UI 不传时退化为透传 not-found。
		api.registerGatewayMethod('coclaw.agent.abort', ({ params, respond }) => {
			try {
				const sessionId = params?.sessionId;
				if (typeof sessionId !== 'string' || !sessionId) {
					logger.warn?.(`[coclaw.agent.abort] invalid sessionId: ${JSON.stringify(sessionId)}`);
					respondInvalid(respond, 'sessionId is required');
					return;
				}
				const abortResult = abortAgentRun(sessionId);
				const runDuration = typeof params?.runDuration === 'number' ? params.runDuration : undefined;
				const abortDuration = typeof params?.abortDuration === 'number' ? params.abortDuration : undefined;
				const result = decideCancelResponse(abortResult, { runDuration, abortDuration });
				// not-found 是 UI 重试期常态（注册空窗），不打日志避免噪音；其余分支保留 info
				if (result.reason !== 'not-found') {
					logger.info?.(`[coclaw.agent.abort] result sessionId=${sessionId} ok=${result.ok}${result.reason ? ` reason=${result.reason}` : ''}${result.error ? ` error=${result.error}` : ''}`);
				}
				if (result.ok) {
					remoteLog(`abort.success sid=${sessionId}`);
				}
				else if (result.reason === 'not-supported') {
					// 侧门缺失或 handle shape 变化：OpenClaw 升级契约变更的早期信号
					remoteLog(`abort.not-supported sid=${sessionId}`);
				}
				else if (result.reason === 'gone') {
					// 启发升格：双闸均达阈值，把 not-found 升格为 gone，让 UI 主动 settleByCancel
					remoteLog(`abort.gone sid=${sessionId} runDur=${runDuration} abortDur=${abortDuration}`);
				}
				respond(true, result);
			}
			catch (err) {
				logger.error?.(`[coclaw.agent.abort] handler threw: ${String(err?.message ?? err)}`);
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.upgradeHealth', async ({ respond }) => {
			try {
				const { version } = await getPackageInfo();
				respond(true, { version });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		// --- 文件管理 RPC（WS fallback，RTC 路径由 webrtc-peer 本地拦截） ---

		const fileHandler = createFileHandler({
			resolveWorkspace: (agentId) => {
				const cfg = api.runtime?.config?.loadConfig();
				const dir = api.runtime?.agent?.resolveAgentWorkspaceDir(cfg, agentId);
				if (!dir) {
					const err = new Error('Cannot resolve workspace: runtime not available');
					err.code = 'AGENT_DENIED';
					throw err;
				}
				return dir;
			},
			logger,
		});

		api.registerGatewayMethod('coclaw.files.list', async ({ params, respond }) => {
			try {
				respond(true, await fileHandler.listFiles(params ?? {}));
			} catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.files.delete', async ({ params, respond }) => {
			try {
				respond(true, await fileHandler.deleteFile(params ?? {}));
			} catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.files.mkdir', async ({ params, respond }) => {
			try {
				respond(true, await fileHandler.mkdirOp(params ?? {}));
			} catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.files.create', async ({ params, respond }) => {
			try {
				respond(true, await fileHandler.createFile(params ?? {}));
			} catch (err) {
				respondError(respond, err);
			}
		});

		// provider 认证管理 RPC（API key 写入 / 列表 / 撤销）。SDK 走懒加载 dynamic import，
		// 不增加本插件 cold-load 开销，也让测试环境无需 openclaw 包就能加载 index.js。
		// loadSdk 字面量必须留在本入口源码里：OpenClaw plugin loader 只扫入口文件识别
		// `openclaw/plugin-sdk/*` 字符串字面量、命中后才把整张依赖图过 jiti 改写到自家 dist；
		// 字面量留在子模块里 loader 看不到 → 整张图走原生 Node 解析必败（plugin 部署目录不带 openclaw 包）
		registerProviderAuthHandlers(api, {
			loadSdk: () => import('openclaw/plugin-sdk/provider-auth'),
		});

		// 模型默认配置 RPC（coclaw.model.set / list）。三个 SDK 子入口的字面量
		// dynamic import 必须留在本入口源码——OpenClaw plugin loader 只扫入口源码
		// 命中 `openclaw/plugin-sdk/*` 字面量并触发 jiti 重写；藏在子模块的字面量
		// loader 看不到 → 原生 Node 解析必败。
		registerModelDefaultHandlers(api, {
			loadConfigMutation: () => import('openclaw/plugin-sdk/config-mutation'),
			loadModelsProviderRuntime: () => import('openclaw/plugin-sdk/models-provider-runtime'),
			loadProviderAuth: () => import('openclaw/plugin-sdk/provider-auth'),
		});

		const scheduler = new AutoUpgradeScheduler({ pluginId: api.id, logger });
		api.registerService({
			id: 'coclaw-auto-upgrade',
			start() { scheduler.start(); },
			stop() { scheduler.stop(); },
		});

		api.registerCommand({
			name: 'coclaw',
			description: 'CoClaw bind/unbind command',
			acceptsArgs: true,
			handler: async (ctx) => {
				const { action, positionals, options } = parseCommandArgs(ctx.args);
				if (action === 'help') {
					return { text: buildHelpText() };
				}

				try {
					if (action === 'bind') {
						const result = await doBind({
							code: positionals[0],
							serverUrl: options.server,
						});
						return { text: bindOk(result) };
					}

					if (action === 'enroll') {
						// 并发控制：取消前一个 enroll（与 RPC 路径共享 helper）
						cancelActiveEnroll();
						const abortController = new AbortController();
						activeEnrollAbort = abortController;

						const serverUrl = options.server ?? api.pluginConfig?.serverUrl;
						const result = await enrollClaw({ serverUrl });
						const rawMinutes = Math.round(
							(new Date(result.expiresAt).getTime() - Date.now()) / 60_000,
						);
						const expiresMinutes = Number.isFinite(rawMinutes) ? rawMinutes : 30;

						// 后台 fire-and-forget：等待认领完成后写 config + 启 bridge
						waitForClaimAndSave({
							serverUrl: result.serverUrl,
							code: result.code,
							waitToken: result.waitToken,
							signal: abortController.signal,
						}).then(async () => {
							if (abortController.signal.aborted) return;
							await restartBridge();
							logger.info?.('[coclaw] enroll completed via slash command, bridge restarted');
						}).catch((err) => {
							if (abortController.signal.aborted) return;
							logger.warn?.(`[coclaw] enroll wait failed: ${String(err?.message ?? err)}`);
						}).finally(() => {
							if (activeEnrollAbort === abortController) {
								activeEnrollAbort = null;
							}
						});

						return {
							text: claimCodeCreated({
								code: result.code,
								appUrl: result.appUrl,
								expiresMinutes,
							}),
						};
					}

					if (action === 'unbind') {
						const result = await doUnbind({ serverUrl: options.server });
						return { text: unbindOk(result) };
					}

					return { text: buildHelpText() };
				}
				catch (err) {
					if (err.code === 'NOT_BOUND') {
						return { text: notBound() };
					}
					logger.warn?.(`[coclaw] command failed: ${String(err?.message ?? err)}`);
					return {
						text: `Error: ${resolveErrorMessage(err)}`,
					};
				}
			},
		});
	},
};
/* c8 ignore stop */

export default plugin;
