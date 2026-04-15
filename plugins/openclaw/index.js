import { bindClaw, unbindClaw, enrollClaw, waitForClaimAndSave } from './src/common/claw-binding.js';
import { registerCoclawCli } from './src/cli-registrar.js';
import { resolveErrorMessage } from './src/common/errors.js';
import { notBound, bindOk, unbindOk, claimCodeCreated } from './src/common/messages.js';
import { coclawChannelPlugin } from './src/channel-plugin.js';
import { ensureAgentSession, gatewayAgentRpc, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady, broadcastPluginEvent } from './src/realtime-bridge.js';
import { getHostName, readSettings, writeName, MAX_NAME_LENGTH } from './src/settings.js';
import { setRuntime } from './src/runtime.js';
import { createSessionManager } from './src/session-manager/manager.js';
import { TopicManager } from './src/topic-manager/manager.js';
import { ChatHistoryManager } from './src/chat-history-manager/manager.js';
import { generateTitle } from './src/topic-manager/title-gen.js';
import { AutoUpgradeScheduler } from './src/auto-upgrade/updater.js';
import { getPackageInfo } from './src/auto-upgrade/updater-check.js';
import { createFileHandler } from './src/file-manager/handler.js';
import { abortAgentRun } from './src/agent-abort.js';
import { remoteLog } from './src/remote-log.js';

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
const plugin = {
	id: 'openclaw-coclaw',
	name: 'CoClaw',
	description: 'OpenClaw CoClaw channel plugin for remote chat',
	register(api) {
		setRuntime(api.runtime);
		const logger = api?.logger ?? console;
		installAbortRegistryDiag(logger);
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

		api.registerChannel({ plugin: coclawChannelPlugin });

		// 追踪 chat 因 reset 产生的孤儿 session
		if (typeof api.on === 'function') {
			api.on('session_start', async (event, ctx) => {
				if (!event.resumedFrom) return; // 首次创建，无前任
				const agentId = ctx?.agentId ?? 'main';
				const sessionKey = event.sessionKey;
				if (!sessionKey) return;
				try {
					if (!chatHistoryManager.__cache.has(agentId)) {
						await chatHistoryManager.load(agentId);
					}
					await chatHistoryManager.recordArchived({
						agentId,
						sessionKey,
						sessionId: event.resumedFrom,
					});
				} catch (err) {
					logger.warn?.(`[coclaw] chat history record failed: ${String(err?.message ?? err)}`);
				}
			});
		}

		api.registerService({
			id: 'coclaw-realtime-bridge',
			async start() {
				await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
			},
			async stop() {
				await stopRealtimeBridge();
			},
		});

		// --- bind/unbind 共享逻辑（RPC handler + 斜杠命令共用） ---

		async function doBind({ code, serverUrl }) {
			await stopRealtimeBridge();
			let result;
			try {
				result = await bindClaw({
					code,
					serverUrl: serverUrl ?? api.pluginConfig?.serverUrl,
				});
			} catch (err) {
				// bind 失败时恢复 bridge（best-effort，不覆盖原始错误）
				await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig }).catch(() => {});
				throw err;
			}
			// bind 已持久化，restart 失败不影响结果
			await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig }).catch((err) => {
				logger.warn?.(`[coclaw] bridge restart failed after bind: ${err?.message ?? err}`);
			});
			return result;
		}

		async function doUnbind({ serverUrl }) {
			const result = await unbindClaw({
				serverUrl: serverUrl ?? api.pluginConfig?.serverUrl,
			});
			await stopRealtimeBridge();
			return result;
		}

		api.registerGatewayMethod('coclaw.bind', async ({ params, respond }) => {
			try {
				const code = params?.code;
				if (!code) {
					respondInvalid(respond, 'code is required');
					return;
				}
				const result = await doBind({
					code,
					serverUrl: params?.serverUrl,
				});
				respond(true, {
					status: {
						clawId: result.clawId,
						rebound: result.rebound,
						previousClawId: result.previousClawId,
					},
				});
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.unbind', async ({ params, respond }) => {
			try {
				const result = await doUnbind({ serverUrl: params?.serverUrl });
				respond(true, { status: { clawId: result.clawId } });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		// enroll 并发控制：同一时刻只允许一个活跃 enroll
		let activeEnrollAbort = null;

		api.registerGatewayMethod('coclaw.enroll', async ({ params, respond }) => {
			try {
				// 取消前一个 enroll
				if (activeEnrollAbort) {
					activeEnrollAbort.abort();
				}
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
					status: {
						code: result.code,
						appUrl: result.appUrl,
						expiresAt: result.expiresAt,
						expiresMinutes,
					},
				});

				// 后台 fire-and-forget：等待认领并保存 config + 启 bridge
				waitForClaimAndSave({
					serverUrl: result.serverUrl,
					code: result.code,
					waitToken: result.waitToken,
					signal: abortController.signal,
				}).then(async () => {
					if (abortController.signal.aborted) return;
					await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
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
				respond(true, manager.listAll(params ?? {}));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('nativeui.sessions.get', ({ params, respond }) => {
			try {
				respond(true, manager.get(params ?? {}));
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

		api.registerGatewayMethod('coclaw.topics.getHistory', ({ params, respond }) => {
			try {
				const topicId = params?.topicId?.trim?.();
				if (!topicId) {
					respondInvalid(respond, 'topicId required');
					return;
				}
				const agentId = params?.agentId?.trim?.() || 'main';
				// 直接复用 session-manager 的 get()，topicId 即 sessionId
				respond(true, manager.get({ agentId, sessionId: topicId }));
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
				await topicManager.updateTitle({ topicId, title: changes.title });
				const { topic } = topicManager.get({ topicId });
				if (!topic) {
					respondInvalid(respond, `Topic not found: ${topicId}`);
					return;
				}
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
		api.registerGatewayMethod('coclaw.sessions.getById', ({ params, respond }) => {
			try {
				const sessionId = params?.sessionId?.trim?.();
				if (!sessionId) {
					respondInvalid(respond, 'sessionId required');
					return;
				}
				const agentId = params?.agentId?.trim?.() || 'main';
				const limit = params?.limit;
				respond(true, manager.getById({ agentId, sessionId, limit }));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		// 取消正在执行的 embedded agent run（通过 OpenClaw 全局 symbol 侧门）
		// 侧门不存在 / sessionId 未注册 / handle.abort 抛异常时返回 { ok:false, reason } —— UI 静默降级
		// UI 可能在 OpenClaw 注册 sessionId 前点 STOP（注册空窗期），此时返回 not-found；UI 会按 500ms 间隔重试。
		api.registerGatewayMethod('coclaw.agent.abort', ({ params, respond }) => {
			try {
				const sessionId = params?.sessionId;
				if (typeof sessionId !== 'string' || !sessionId) {
					logger.warn?.(`[coclaw.agent.abort] invalid sessionId: ${JSON.stringify(sessionId)}`);
					respondInvalid(respond, 'sessionId is required');
					return;
				}
				const result = abortAgentRun(sessionId);
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

		const scheduler = new AutoUpgradeScheduler({ pluginId: api.id, logger });
		api.registerService({
			id: 'coclaw-auto-upgrade',
			start() { scheduler.start(); },
			stop() { scheduler.stop(); },
		});

		api.registerCli(registerCoclawCli, { commands: ['coclaw'] });

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
						// 并发控制：取消前一个 enroll（与 RPC 路径共享）
						if (activeEnrollAbort) {
							activeEnrollAbort.abort();
						}
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
							await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
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
