import fs from 'node:fs/promises';
import nodePath from 'node:path';

import { bindBot, unbindBot, enrollBot, waitForClaimAndSave } from './src/common/bot-binding.js';
import { registerCoclawCli } from './src/cli-registrar.js';
import { resolveErrorMessage } from './src/common/errors.js';
import { notBound, bindOk, unbindOk, claimCodeCreated } from './src/common/messages.js';
import { coclawChannelPlugin } from './src/channel-plugin.js';
import { ensureAgentSession, gatewayAgentRpc, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady } from './src/realtime-bridge.js';
import { setRuntime } from './src/runtime.js';
import { createSessionManager } from './src/session-manager/manager.js';
import { TopicManager } from './src/topic-manager/manager.js';
import { ChatHistoryManager } from './src/chat-history-manager/manager.js';
import { generateTitle } from './src/topic-manager/title-gen.js';
import { AutoUpgradeScheduler } from './src/auto-upgrade/updater.js';
import { getPackageInfo } from './src/auto-upgrade/updater-check.js';

// 延迟读取 + 缓存：避免模块加载时 package.json 损坏导致插件整体无法注册
let __pluginVersion = null;
export async function getPluginVersion() {
	if (__pluginVersion) return __pluginVersion;
	try {
		const pkgPath = nodePath.resolve(import.meta.dirname, 'package.json');
		const raw = await fs.readFile(pkgPath, 'utf8');
		__pluginVersion = JSON.parse(raw).version ?? 'unknown';
	} catch {
		return 'unknown';
	}
	return __pluginVersion;
}
// 测试用：重置缓存
export function __resetPluginVersion() { __pluginVersion = null; }


function parseCommandArgs(args) {
	/* c8 ignore next */
	const tokens = (args ?? '').split(/\s+/).filter(Boolean);
	/* c8 ignore next */
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
		/* c8 ignore next */
		message: String(err?.message ?? err),
	});
}

function respondInvalid(respond, message) {
	respond(false, undefined, { code: 'INVALID_INPUT', message });
}

/* c8 ignore start */
const plugin = {
	id: 'openclaw-coclaw',
	name: 'CoClaw',
	description: 'OpenClaw CoClaw channel plugin for remote chat',
	register(api) {
		setRuntime(api.runtime);
		const logger = api?.logger ?? console;
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

		api.registerGatewayMethod('coclaw.refreshBridge', async ({ respond }) => {
			try {
				await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
				respond(true, { status: 'refreshed' });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.stopBridge', async ({ respond }) => {
			try {
				await stopRealtimeBridge();
				respond(true, { status: 'stopped' });
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
				const result = await enrollBot({ serverUrl });

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

		api.registerGatewayMethod('coclaw.info', async ({ respond }) => {
			try {
				await waitForSessionsReady();
				const version = await getPluginVersion();
				respond(true, { version, capabilities: ['topics', 'chatHistory'] });
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

		api.registerGatewayMethod('coclaw.upgradeHealth', async ({ respond }) => {
			try {
				const { version } = await getPackageInfo();
				respond(true, { version });
			}
			catch (err) {
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
						await stopRealtimeBridge(); // 先断开，避免 bindBot 内 unbind 触发 bot.unbound 竞态
						const serverUrl = options.server ?? api.pluginConfig?.serverUrl;
						const result = await bindBot({
							code: positionals[0],
							serverUrl,
						});
						await restartRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
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
						const result = await enrollBot({ serverUrl });
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
						const result = await unbindBot({ serverUrl: options.server });
						await stopRealtimeBridge();
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
