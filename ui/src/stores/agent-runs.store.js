/**
 * Agent Run 全局注册表
 * 职责：跟踪所有活跃的 agent run，缓冲流式消息；维护 per-run watcher 协调四路结束信号
 *
 * 四路结束信号：
 *   1) 调用 runAgent 时 conn.request('agent', ...) 第二阶段 res 到达 → __onRpcDone
 *   2) event:agent lifecycle:end/error 事件 → __onLifecycleEnd（由 __dispatch 路由）
 *   3) 事件流静默超 IDLE_THRESHOLD_MS 后启动长挂 agent.wait 拿到结果 → __pollOnce
 *   4) 任意 RPC 错误（DC 断、send 失败、wait 超时等异常）→ __onRpcFailed
 *
 * 任一信号触发 __endRun(reason)：标记 ended=true、停 watcher、唤醒 runAgent 的最终 promise。
 * chat.store 拿到 promise resolve 后 await loadMessages，再调 dropRun(runKey) 释放 streamingMsgs。
 *
 * event:agent 事件由 clawsStore.__bridgeConn 集中桥接到 __dispatch；本 store 不自管 per-conn 监听器。
 */
import { defineStore } from 'pinia';
import { applyAgentEvent } from '../utils/agent-stream.js';

/**
 * post-acceptance 内存释放保险（24 小时）。
 * 正常路径下 run 由 watcher 在合理时间内 endRun + chat.store dropRun 收尾，此 timer 不会触发。
 * 仅作异常情况下 streamingMsgs 永久占用内存的保险。
 */
export const POST_ACCEPT_TIMEOUT_MS = 24 * 60 * 60_000;

/** 事件流静默超过此时长，watcher 启动长挂 agent.wait 探测 run 状态 */
const IDLE_THRESHOLD_MS = 30_000;
/** agent.wait 服务端 timeoutMs */
const WAIT_TIMEOUT_MS = 30_000;
/** agent.wait 客户端 RPC 超时（略大于服务端，避免提前 timeout 把长挂掐断） */
const WAIT_REQUEST_TIMEOUT_MS = WAIT_TIMEOUT_MS + 3_000;

/** agent.wait 终态 status */
const TERMINAL_WAIT_STATUSES = new Set(['ok', 'error']);

export const useAgentRunsStore = defineStore('agentRuns', {
	state: () => ({
		/**
		 * 活跃 run 注册表
		 * @type {Record<string, RunState>}
		 * RunState: { runId, clawId, runKey, topicMode, anchorMsgId, startTime, ended, cancelled,
		 *             lastEventAt, streamingMsgs, __conn, __timer, __watcher }
		 */
		runs: {},
		/**
		 * runKey → runId 索引（按 chat/topic 查询）
		 * runKey = `${clawId}::${chatSessionKey}`（chat 模式）或 sessionId（topic 模式）
		 * @type {Record<string, string>}
		 */
		runKeyIndex: {},
	}),

	getters: {
		/**
		 * 根据 runKey 获取 run（只要 entry 存在就返回，allMessages 据此合并 streamingMsgs）
		 * @returns {(runKey: string) => RunState | null}
		 */
		getActiveRun: (state) => (runKey) => {
			const runId = state.runKeyIndex[runKey];
			if (!runId) return null;
			return state.runs[runId] ?? null;
		},
		/**
		 * 指定 runKey 是否仍在运行（UI 判断"思考中"+ cancel coordination tick 判断是否继续 abort）。
		 * 仅终态信号到达（ended）即视为非 running；cancelled 仅是用户意图标记，watcher 仍跑。
		 * @returns {(runKey: string) => boolean}
		 */
		isRunning: (state) => (runKey) => {
			const runId = state.runKeyIndex[runKey];
			if (!runId) return false;
			const run = state.runs[runId];
			return !!run && !run.ended;
		},
		/** 是否有任何 entry（streamingMsgs 仍占内存即视为 busy） */
		busy: (state) => Object.keys(state.runs).length > 0,
	},

	actions: {
		/**
		 * 注册新 run（通常由 runAgent 在 accepted 时内部调用）
		 * @param {string} runId
		 * @param {object} opts
		 * @param {string} opts.clawId
		 * @param {string} opts.runKey
		 * @param {boolean} opts.topicMode
		 * @param {object} opts.conn - ClawConnection 实例
		 * @param {object[]} opts.streamingMsgs - 初始流式消息
		 * @param {string|null} [opts.anchorMsgId]
		 */
		register(runId, { clawId, runKey, topicMode, conn, streamingMsgs = [], anchorMsgId = null }) {
			console.debug('[agentRuns] register runId=%s runKey=%s clawId=%s', runId, runKey, clawId);

			// 清理同一 runKey 的旧 run——先 endRun 唤起 onEnd，避免旧 runAgent 的 finalPromise 泄漏
			const oldRunId = this.runKeyIndex[runKey];
			if (oldRunId && this.runs[oldRunId]) {
				this.__cleanupRun(oldRunId, 'superseded');
			}

			const run = {
				runId,
				clawId,
				runKey,
				topicMode,
				anchorMsgId,
				startTime: Date.now(),
				ended: false,
				cancelled: false,
				lastEventAt: 0,
				streamingMsgs: [...streamingMsgs],
				__conn: conn,
				__timer: null,
				__watcher: null,
			};
			this.runs[runId] = run;
			this.runKeyIndex[runKey] = runId;

			// 内存释放保险
			run.__timer = setTimeout(() => {
				console.debug('[agentRuns] post-acceptance memory timeout runId=%s', runId);
				this.__endRun(runId, 'timeout');
				this.dropRun(runKey, runId);
			}, POST_ACCEPT_TIMEOUT_MS);

			this.__startWatcher(runId);
		},

		/**
		 * 发起 agent run：发 RPC、accepted 时 register、维护 watcher、返回最终 promise
		 *
		 * 返回 promise 的语义：
		 *   - resolve `{ runId, accepted: true, endReason }` —— accepted 后任何路径都 resolve
		 *     endReason ∈ 'rpc'(信号1) | 'lifecycle'(信号2) | 'wait'(信号3) | 'failed'(信号4) | 'timeout'(24h 兜底)
		 *   - reject —— pre-acceptance 阶段错误（DC 断、连接超时、参数校验失败、用户取消）
		 *
		 * @param {object} opts
		 * @param {object} opts.conn - ClawConnection 实例
		 * @param {string} opts.clawId
		 * @param {string} opts.runKey
		 * @param {boolean} opts.topicMode
		 * @param {object} opts.agentParams - 透传给 conn.request('agent', ...)
		 * @param {object[]} [opts.optimisticMsgs] - 注册时的乐观流式消息
		 * @param {string|null} [opts.anchorMsgId]
		 * @param {(payload: object) => void} [opts.onAccepted] - accepted 瞬间的 UI 钩子（在 register 之后触发）
		 * @returns {Promise<{ runId: string, accepted: boolean, endReason: string }>}
		 */
		async runAgent({ conn, clawId, runKey, topicMode, agentParams, optimisticMsgs = [], anchorMsgId = null, onAccepted }) {
			let registeredRunId = null;
			let preAcceptError = null;
			let finalResolve;
			const finalPromise = new Promise((resolve) => { finalResolve = resolve; });

			// 发起 RPC：不直接 await（否则 watcher 路径触发的 endRun 会与未到的第二阶段 res 互相等待死锁）。
			// 通过 then/catch 处理两路结局：信号 1（RPC res）/ 信号 4（accepted 后 reject）/ pre-acceptance 错误
			conn.request('agent', agentParams, {
				timeout: 0,
				onAccepted: (payload) => {
					const runId = payload?.runId ?? null;
					if (!runId) return;
					registeredRunId = runId;
					this.register(runId, {
						clawId, runKey, topicMode, conn,
						streamingMsgs: optimisticMsgs,
						anchorMsgId,
					});
					// 把 final hook 挂到 watcher，由 __endRun 唤醒
					const run = this.runs[runId];
					if (run?.__watcher) {
						run.__watcher.onEnd = (reason) => {
							finalResolve({ runId, accepted: true, endReason: reason });
						};
					}
					if (onAccepted) {
						try { onAccepted(payload); }
						catch (e) { console.error('[agentRuns] onAccepted callback err:', e); }
					}
				},
				onUnknownStatus: (status, payload) => {
					console.error('[agentRuns] unknown agent rpc status=%s', status, payload);
				},
			}).then(
				(rpcResult) => {
					if (registeredRunId) {
						// 信号 1
						this.__onRpcDone(registeredRunId, rpcResult);
					} else {
						// 极罕见：RPC 直接返回 ok=true 但未 accepted
						finalResolve({ runId: null, accepted: false, endReason: 'norun' });
					}
				},
				(err) => {
					if (registeredRunId) {
						// 信号 4：accepted 后 RPC reject
						this.__onRpcFailed(registeredRunId, err);
					} else {
						// pre-acceptance 错误
						preAcceptError = err;
						finalResolve(null);
					}
				},
			);

			const result = await finalPromise;
			if (preAcceptError) throw preAcceptError;
			return result;
		},

		/**
		 * chat.store loadMessages 完成后调用：真正释放 streamingMsgs 与 entry。
		 * 传入 expectedRunId 防误删：loadMessages 期间用户发新消息可能让 runKey 被新 run 占据，
		 * 此时老 runPromise.then 的 dropRun 应跳过（新 run 的 lifecycle 会独立走自己的收尾）。
		 * @param {string} runKey
		 * @param {string} [expectedRunId] - 仅在 runKeyIndex 仍指向此 runId 时清理
		 */
		dropRun(runKey, expectedRunId) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			if (expectedRunId && runId !== expectedRunId) return;
			this.__cleanupRun(runId);
		},

		// ============================ watcher ============================

		__startWatcher(runId) {
			const run = this.runs[runId];
			if (!run) return;
			run.__watcher = {
				idleTimer: null,
				waitPending: false,
				onEnd: null,
			};
			this.__armIdleTimer(runId);
		},

		__armIdleTimer(runId) {
			const run = this.runs[runId];
			if (!run || run.ended || !run.__watcher) return;
			if (run.__watcher.idleTimer) {
				clearTimeout(run.__watcher.idleTimer);
			}
			run.__watcher.idleTimer = setTimeout(() => {
				this.__pollOnce(runId);
			}, IDLE_THRESHOLD_MS);
		},

		__noteEvent(runId) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			run.lastEventAt = Date.now();
			this.__armIdleTimer(runId);
		},

		/**
		 * 长挂 agent.wait 一次。运行端事件驱动，正常路径事件到达即 resolve；
		 * 真超时（活跃）→ 立即下一轮；wait 失败 → endRun('failed')
		 */
		async __pollOnce(runId) {
			const run = this.runs[runId];
			if (!run || run.ended || !run.__watcher) return;
			if (run.__watcher.waitPending) return;
			const conn = run.__conn;
			if (!conn) return;

			run.__watcher.waitPending = true;
			let result;
			try {
				result = await conn.request('agent.wait', {
					runId,
					timeoutMs: WAIT_TIMEOUT_MS,
				}, { timeout: WAIT_REQUEST_TIMEOUT_MS });
			}
			catch (err) {
				const r = this.runs[runId];
				if (!r || r.ended) return;
				r.__watcher.waitPending = false;
				console.debug('[agentRuns] agent.wait failed runId=%s err=%s', runId, err?.message);
				this.__endRun(runId, 'failed');
				return;
			}

			const r = this.runs[runId];
			if (!r || r.ended) return;
			r.__watcher.waitPending = false;

			const status = result?.status;
			if (TERMINAL_WAIT_STATUSES.has(status)) {
				this.__endRun(runId, 'wait');
				return;
			}
			if (status !== 'timeout') {
				// 异常响应（无 status / 未知 status）—— 防御：按结束处理避免下一轮死循环
				console.warn('[agentRuns] agent.wait unexpected result runId=%s', runId, result);
				this.__endRun(runId, 'wait');
				return;
			}
			// status === 'timeout'：靠 endedAt 间接区分
			if (result?.endedAt) {
				// run 已结束（abort / TTL 写入），按结束处理
				this.__endRun(runId, 'wait');
				return;
			}
			// 真超时（活跃）：立即下一轮
			this.__pollOnce(runId);
		},

		__onRpcDone(runId) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			this.__endRun(runId, 'rpc');
		},

		__onLifecycleEnd(runId) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			this.__endRun(runId, 'lifecycle');
		},

		__onRpcFailed(runId, err) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			console.debug('[agentRuns] rpc failed runId=%s err=%s', runId, err?.message);
			this.__endRun(runId, 'failed');
		},

		/**
		 * 终结 run：标记 ended、停 watcher、唤醒 finalPromise；不释放 streamingMsgs（等 dropRun）
		 * @param {string} runId
		 * @param {string} reason - 'rpc' | 'lifecycle' | 'wait' | 'failed' | 'timeout' | 'manual'
		 */
		__endRun(runId, reason) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			console.debug('[agentRuns] endRun runId=%s reason=%s', runId, reason);
			run.ended = true;
			if (run.__watcher?.idleTimer) {
				clearTimeout(run.__watcher.idleTimer);
				run.__watcher.idleTimer = null;
			}
			if (run.__timer) {
				clearTimeout(run.__timer);
				run.__timer = null;
			}
			const onEnd = run.__watcher?.onEnd;
			if (run.__watcher) run.__watcher.onEnd = null;
			// 触发响应式更新（让 isRunning getter 通知 UI）
			this.runs[runId] = { ...run };
			if (onEnd) {
				try { onEnd(reason); }
				catch (e) { console.error('[agentRuns] onEnd hook err:', e); }
			}
		},

		// ============================ 事件路由 ============================

		/**
		 * 内部：处理 event:agent 事件（由 clawsStore.__bridgeConn 集中调用）
		 * @param {object} payload
		 */
		__dispatch(payload) {
			const runId = payload?.runId;
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.ended) return;

			const { changed, settled } = applyAgentEvent(run.streamingMsgs, payload);
			if (changed) {
				this.runs[runId] = { ...run, streamingMsgs: [...run.streamingMsgs] };
			}
			if (settled) {
				this.__onLifecycleEnd(runId);
			} else {
				this.__noteEvent(runId);
			}
		},

		// ============================ 用户取消协调 ============================

		/**
		 * 用户取消（cancelSend 阶段 1）：标记 cancelled=true，watcher 仍跑等待真实终态信号
		 * isRunning 立即 false（UI 恢复输入），streamingMsgs 保留显示直到 endRun + dropRun
		 * @param {string} runKey
		 */
		settleWithTransitionByKey(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.ended || run.cancelled) return;
			run.cancelled = true;
			this.runs[runId] = { ...run };
		},

		/**
		 * 手动 settle（外部 API 保留：僵尸清理 / page unmount 等场景）
		 * @param {string} runKey
		 */
		settle(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run) return;
			if (!run.ended) {
				this.__endRun(runId, 'manual');
			}
			this.__cleanupRun(runId);
		},

		// ============================ 数据维护 ============================

		/**
		 * 去除 streamingMsgs 中的乐观 user 消息——基于锚点范围的存在性判断：
		 * 仅当 server 数据在 anchorMsgId 之后已出现 user message 时才 strip。
		 * @param {string} runKey
		 * @param {object[]} serverMessages - loadMessages 返回的服务端消息
		 */
		stripLocalUserMsgs(runKey, serverMessages = []) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.ended) return;
			if (!run.streamingMsgs.some((m) => m._local && m.message?.role === 'user')) return;

			const anchorId = run.anchorMsgId;
			let serverHasUserMsg;
			if (!anchorId) {
				serverHasUserMsg = serverMessages.some((m) => m.message?.role === 'user');
			} else {
				let anchorIdx = -1;
				for (let i = serverMessages.length - 1; i >= 0; i--) {
					if (serverMessages[i].id === anchorId) { anchorIdx = i; break; }
				}
				if (anchorIdx === -1) {
					serverHasUserMsg = true;
				} else {
					serverHasUserMsg = serverMessages.slice(anchorIdx + 1).some((m) => m.message?.role === 'user');
				}
			}
			if (!serverHasUserMsg) return;

			const filtered = run.streamingMsgs.filter(
				(m) => !(m._local && m.message?.role === 'user'),
			);
			if (filtered.length !== run.streamingMsgs.length) {
				for (const m of run.streamingMsgs) {
					if (!m._local || m.message?.role !== 'user' || !m._attachments) continue;
					for (const att of m._attachments) {
						if (att.url) URL.revokeObjectURL(att.url);
					}
				}
				this.runs[runId] = { ...run, streamingMsgs: filtered };
			}
		},

		// ============================ cleanup ============================

		/**
		 * 清理单个 run：若尚未 ended 先 endRun 唤起 onEnd，再清 timer / 释放 blob URL / 删 entry + 索引
		 * @param {string} runId
		 * @param {string} [reason] - 未 ended 时传给 __endRun 的 endReason
		 */
		__cleanupRun(runId, reason = 'cleanup') {
			const run = this.runs[runId];
			if (!run) return;

			// 外部路径（register 清旧 run / removeByClaw / settle manual）可能在未终结时 cleanup，
			// 此时必须先 __endRun 唤起 onEnd，避免 runAgent 的 finalPromise 悬挂泄漏
			if (!run.ended) this.__endRun(runId, reason);

			if (run.__timer) {
				clearTimeout(run.__timer);
				run.__timer = null;
			}
			if (run.__watcher?.idleTimer) {
				clearTimeout(run.__watcher.idleTimer);
				run.__watcher.idleTimer = null;
			}

			for (const m of run.streamingMsgs) {
				if (!m._attachments) continue;
				for (const att of m._attachments) {
					if (att.url) URL.revokeObjectURL(att.url);
				}
			}

			if (this.runKeyIndex[run.runKey] === runId) {
				delete this.runKeyIndex[run.runKey];
			}
			delete this.runs[runId];
		},

		/**
		 * claw 移除时清理该 claw 的所有 runs
		 * @param {string} clawId
		 */
		removeByClaw(clawId) {
			const runIds = Object.keys(this.runs).filter((id) => this.runs[id].clawId === clawId);
			for (const runId of runIds) {
				this.__cleanupRun(runId, 'claw-removed');
			}
		},
	},
});
