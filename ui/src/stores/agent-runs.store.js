/**
 * Agent Run 全局注册表
 * 职责：跟踪所有活跃的 agent run，缓冲流式消息；维护 per-run watcher 协调三路结束信号
 *
 * 三路结束信号：
 *   1) 调用 runAgent 时 conn.request('agent', ...) 第二阶段 res 到达 → __onRpcDone
 *   2) 事件流静默超 IDLE_THRESHOLD_MS 后用 agent.wait(timeoutMs=0) 即时探测 → __pollOnce
 *      （当前 IDLE_THRESHOLD_MS 暂设为 24h，等于 run wall-clock TTL，实际不会触发；
 *      代码骨架保留，待 plugin 端补"agent run 终态查询"新 RPC 后改回 60s）
 *   3) 主 agent() RPC 失败（DC 物理死亡 RTC_LOST/DC_CLOSED 等）→ __onRpcFailed
 *
 * **lifecycle:end 不再作为结束信号**：OpenClaw 上游一次完整 run 内会 emit 多次
 * lifecycle:end（compaction-retry / model-fallback / live-switch），payload 无字段
 * 可区分中间段 vs 真终态——把第一个当真终态会导致提前 endRun、后续事件被
 * __dispatch 入口的 ended guard 全部丢弃（用户体感"任务未完成 + 终止按钮消失但
 * 实际还在跑"）。lifecycle 事件现在仅当普通流量用：刷新 lastEventAt + 重 arm
 * idleTimer，本身不挂 grace、不 endRun。
 *
 * **agent.wait 是探测 RPC，不承担判死责任**：wait 自身的 reject（包括 wall-clock
 * 超时、ICE restart 期间网络暂不通）只代表"这次没问到"，按 timeout(无 endedAt) 语义
 * 重 arm idleTimer 等下一轮。run 真死的判断交给信号 3——主 agent() RPC 用 timeout=0
 * （永不 wall-clock 超时），它 reject 主要来自 DC 物理死亡（clearRtc →
 * __rejectAllPending），也包括服务端 ok:false 协议错误（罕见）。
 *
 * **wait(0) 探测的可靠性分层**：服务端 timeoutMs=0 不订阅 lifecycle 流，分两种命中：
 *   - 命中 gateway dedupe（RPC 顶层 promise resolve 时写入）：**真终态、可靠**
 *   - 命中 agent-job cache（被 lifecycle 流污染过）：可能在中间段瞬时窗口被骗，
 *     在 compaction-retry 段间 5–15s、model-fallback / live-switch <1s 才会发生
 * 残留误判窗口由阶段 2（plugin 端基于 RPC res 帧建"已结束 runs"注册表）彻底兜掉。
 *
 * **微任务顺序保证（不 hot loop）**：DC 物理死亡场景，主 agent() RPC 与 wait 几乎
 * 同时被 __rejectAllPending（claw-connection.js）按 Map 插入顺序 reject。主 RPC
 * 先注册先 reject，其 onRejected 微任务在 wait 的之前入队。同一 microtask cycle
 * 内主 RPC 的 errCb 先跑 → __onRpcFailed → __endRun → run.ended=true；wait catch
 * 跑时 r.ended 已为 true，guard 立即 return，不会触发新的 pollOnce 重试。
 *
 * **rpc grace 窗口**：信号 2 到达时不立即收尾，挂一个 RPC_GRACE_MS 计时器等信号 1
 * （rpc 二阶段 res）。窗口内 rpc 来了 → 走 'rpc' 路径（上游同步 await 链保证 transcript
 * 已写完）；窗口耗尽 → 用 'wait' 降级。信号 3（failed）网络异常立刻收尾不等。
 * 这把"等持久化"的逻辑收拢到源头，下游 chat.store 拿到 promise resolve 时数据已经写完，
 * 不需要再做"是否有终态 assistant"的猜测校验，避免 fast follow-up 场景下把上一轮回答误判成本轮终态。
 *
 * 任一信号触发 __endRun(reason)：标记 ended=true、停 watcher、唤醒 runAgent 的最终 promise。
 * chat.store 拿到 promise resolve 后 await loadMessages，再调 dropRun(runKey) 释放 streamingMsgs。
 *
 * event:agent 事件由 clawsStore.__bridgeConn 集中桥接到 __dispatch；本 store 不自管 per-conn 监听器。
 */
import { defineStore } from 'pinia';
import { applyAgentEvent } from '../utils/agent-stream.js';
import { remoteLog } from '../services/remote-log.js';

/**
 * post-acceptance 内存释放保险（24 小时）。
 * 正常路径下 run 由 watcher 在合理时间内 endRun + chat.store dropRun 收尾，此 timer 不会触发。
 * 仅作异常情况下 streamingMsgs 永久占用内存的保险。
 */
export const POST_ACCEPT_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * 事件流静默超过此时长，watcher 用 agent.wait(timeoutMs=0) 即时探测 run 状态。
 *
 * **当前暂设为 24h（= run wall-clock TTL），实际不会触发**：wait(0) 路径有
 * "两本本子失忆"假阴性风险（gateway dedupe 5min TTL + agent-job cache 10min TTL
 * 双双过期窗口下 wait 反馈"还活着"，其实早结束）。一刀切把 idle timer 拉到 24h，
 * agent run 会在此之前由信号 1（主 RPC 二阶段 res）或信号 3（DC 死）正常收尾，
 * idleTimer 永远跑不到点。__pollOnce / wait(0) 调用 / 三返回值分支 / waitPending
 * 全部代码原样保留，待 plugin 端补上"agent run 终态查询"新 RPC 后改回 60s 即可。
 */
export const IDLE_THRESHOLD_MS = POST_ACCEPT_TIMEOUT_MS;

/** agent.wait 终态 status */
const TERMINAL_WAIT_STATUSES = new Set(['ok', 'error']);

/**
 * 信号 2（wait 终态）到达后给信号 1（rpc 二阶段 res）的宽限时长（ms）。
 * wait 命中 gateway dedupe / agent-job cache 时的 endedAt 写入早于 transcript 写盘
 * + rpc 二阶段帧；给 rpc 优先一窗口可以让大多数情况走 'rpc' 快路径（已写完）；
 * 窗口耗尽降级走 'wait'。
 */
export const RPC_GRACE_MS = 2_000;

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
			// 诊断信号：标记某条 run 真的进了 store 注册表（与 agent.run.end 配对，定位"任务未完成"
			// 类问题时，这两条同时缺失即意味 run 从未 register 过——根因在 sendMessage pre-accept 链路）
			remoteLog(`agent.run.registered runId=${runId} runKey=${runKey} clawId=${clawId}`);

			// 清理同一 runKey 的旧 run——先 endRun 唤起 onEnd，避免旧 runAgent 的 finalPromise 泄漏
			const oldRunId = this.runKeyIndex[runKey];
			if (oldRunId && this.runs[oldRunId]) {
				// 诊断信号：在 server 日志里串起新旧 run 的抢占关系
				remoteLog(`agent.run.preempt runKey=${runKey} newRunId=${runId} oldRunId=${oldRunId}`);
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
				/** rpc grace pending 状态：{ reason, timer } | null */
				__pendingEnd: null,
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
		 *     endReason ∈ 'rpc'(信号1) | 'wait'(信号2) | 'failed'(信号3) | 'timeout'(24h 兜底)
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
			// 通过 then/catch 处理两路结局：信号 1（RPC res）/ 信号 3（accepted 后 reject）/ pre-acceptance 错误
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
						remoteLog(`agent.run.norun runKey=${runKey}`);
						finalResolve({ runId: null, accepted: false, endReason: 'norun' });
					}
				},
				(err) => {
					if (registeredRunId) {
						// 信号 3：accepted 后 RPC reject
						this.__onRpcFailed(registeredRunId, err);
					} else {
						// pre-acceptance 错误：register 之前 RPC 就挂了，无 agent.run.end 配对。
						// 单独打这条让此前的"零 endRun"盲区被点亮（chat.store sendMessage 不再重复打）
						remoteLog(`agent.run.preaccept-failed runKey=${runKey} code=${err?.code ?? 'unknown'} msg=${err?.message ?? ''}`);
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
		 * 此时老 runPromise.then 的 dropRun 应跳过（新 run 会独立走自己的终态信号收尾）。
		 * @param {string} runKey
		 * @param {string} [expectedRunId] - 仅在 runKeyIndex 仍指向此 runId 时清理
		 */
		dropRun(runKey, expectedRunId) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			if (expectedRunId && runId !== expectedRunId) return;
			// 诊断信号：streamingMsgs 占位真正释放的瞬间，对应用户看到 "任务未完成" 替换持久化条目
			remoteLog(`agent.run.drop runKey=${runKey} runId=${runId}`);
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
		 * 用 agent.wait(timeoutMs=0) 即时探测一次 run 状态。服务端不订阅 lifecycle 流，
		 * 立刻返回 cache 快照，不阻塞。
		 *
		 * 三种结局：
		 * - 终态 status=ok/error 或 status=timeout+endedAt：挂 grace 等 rpc 优先；
		 *   grace 满走 'wait'。
		 * - status=timeout 无 endedAt（run 仍活跃）：重 arm idleTimer 等下一个静默周期，
		 *   **不递归**——避免 wait(0) 即时返回造成 tight loop。
		 * - wait 本身 reject（wall-clock 超时 / ICE restart 期间网络暂不通）：同样重 arm
		 *   idleTimer。不在此处判死，DC 物理死亡由主 agent() RPC 的 __onRpcFailed 兜底
		 *   （信号 3）。
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
					timeoutMs: 0,
				});
			}
			catch (err) {
				const r = this.runs[runId];
				if (!r || r.ended) return;
				r.__watcher.waitPending = false;
				console.debug('[agentRuns] agent.wait reject runId=%s err=%s → re-arm', runId, err?.message);
				this.__armIdleTimer(runId);
				return;
			}

			const r = this.runs[runId];
			if (!r || r.ended) return;
			r.__watcher.waitPending = false;

			const status = result?.status;
			if (TERMINAL_WAIT_STATUSES.has(status)) {
				// wait 终态也可能早于 rpc 二阶段，挂 grace 等 rpc
				this.__schedulePendingEnd(runId, 'wait');
				return;
			}
			if (status !== 'timeout') {
				// 异常响应（无 status / 未知 status）—— 防御：按结束处理避免下一轮死循环
				console.warn('[agentRuns] agent.wait unexpected result runId=%s', runId, result);
				this.__schedulePendingEnd(runId, 'wait');
				return;
			}
			// status === 'timeout'：靠 endedAt 间接区分
			if (result?.endedAt) {
				// run 已结束（abort / TTL 写入），按结束处理
				this.__schedulePendingEnd(runId, 'wait');
				return;
			}
			// 真超时（活跃）：重 arm idleTimer 等下一个静默周期；不递归（wait(0) tight loop 防御）
			this.__armIdleTimer(runId);
		},

		__onRpcDone(runId) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			// rpc 二阶段最权威——若已挂 grace pending 取消之，直接走 'rpc' 快路径
			this.__clearPendingEnd(runId);
			this.__endRun(runId, 'rpc');
		},

		__onRpcFailed(runId, err) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			console.debug('[agentRuns] rpc failed runId=%s err=%s', runId, err?.message);
			// 网络异常：上游 rpc 二阶段已不可能再到，立即收尾不等 grace
			this.__clearPendingEnd(runId);
			this.__endRun(runId, 'failed');
		},

		/**
		 * 挂 grace pending：等 RPC_GRACE_MS 内信号 1 到达；超时后按记下的 reason 收尾。
		 * 已 pending 时不重复挂（先到的 reason 优先）。
		 * @param {string} runId
		 * @param {string} reason
		 */
		__schedulePendingEnd(runId, reason) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			if (run.__pendingEnd) return;
			const timer = setTimeout(() => {
				const r = this.runs[runId];
				if (!r || r.ended) return;
				r.__pendingEnd = null;
				// 诊断信号：grace 期满 rpc 二阶段仍未到。频率高时考虑调 RPC_GRACE_MS。
				remoteLog(`agent.run.rpc-grace-elapsed runId=${runId} reason=${reason}`);
				this.__endRun(runId, reason);
			}, RPC_GRACE_MS);
			run.__pendingEnd = { reason, timer };
		},

		/** 清掉 grace pending（rpc 抢先到达 / 已 endRun 等场景） */
		__clearPendingEnd(runId) {
			const run = this.runs[runId];
			if (!run?.__pendingEnd) return;
			clearTimeout(run.__pendingEnd.timer);
			run.__pendingEnd = null;
		},

		/**
		 * 终结 run：标记 ended、停 watcher、唤醒 finalPromise；不释放 streamingMsgs（等 dropRun）
		 * @param {string} runId
		 * @param {string} reason - 'rpc' | 'wait' | 'failed' | 'timeout' |
		 *   'manual' | 'superseded' | 'claw-removed' | 'logout' | 'cleanup' |
		 *   'cancel-gone' | 'cancel-not-supported'
		 */
		__endRun(runId, reason) {
			const run = this.runs[runId];
			if (!run || run.ended) return;
			console.debug('[agentRuns] endRun runId=%s reason=%s', runId, reason);
			// 诊断信号：所有 run 终结路径的统一上报点（rpc / wait / failed /
			// timeout / manual / superseded / claw-removed / logout / cleanup）。
			// 与 server 端 RTC/RPC 时间戳对齐用，定位"任务未完成"误判的根因路径
			remoteLog(`agent.run.end runId=${runId} reason=${reason}`);
			run.ended = true;
			// 防御性清 grace pending：覆盖 settle('manual') / __cleanupRun 等绕过 helper 的路径
			if (run.__pendingEnd) {
				clearTimeout(run.__pendingEnd.timer);
				run.__pendingEnd = null;
			}
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

			const { changed } = applyAgentEvent(run.streamingMsgs, payload);
			if (changed) {
				this.runs[runId] = { ...run, streamingMsgs: [...run.streamingMsgs] };
			}
			// lifecycle:end / lifecycle:error 不再触发 endRun；与其他事件一致仅刷新 idleTimer。
			// 终态判定由 __onRpcDone（rpc 二阶段 res）/ __pollOnce（wait(0) 探测）/ __onRpcFailed（主 RPC reject）负责
			this.__noteEvent(runId);
		},

		// ============================ 用户取消协调 ============================

		/**
		 * 用户取消（cancelSend 阶段 1）：标记 cancelled=true，watcher 仍跑等真实终态信号。
		 * 注意：isRunning 不会因此立即变 false（getter 只看 ended）；UI 在 cancelling 期间
		 * 通过 chat.store 的 __cancelling 状态恢复输入框。streamingMsgs 保留显示直到
		 * 真实终态信号到达 → endRun → chat.store loadMessages → dropRun 真正释放。
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

		/**
		 * 由用户 cancel 协调（chat.store __startCancelCoordination）外部驱动主动收尾 run，
		 * 不调用 __cleanupRun——后者会从 runKeyIndex 删 entry，导致后续 loadMessages
		 * + dropRun(runKey, runId) 校验失败而无法释放 streamingMsgs。endRun 后让自然
		 * 路径（runPromise.then → loadMessages → dropRun）继续把 entry 真正释放。
		 *
		 * 用于两类启发式终态：
		 * - 'cancel-gone'：plugin 在 not-found + 双闸（runDuration ≥ 3min, abortDuration ≥ 1min）
		 *   都满足时启发判定 run 已结束（允许误判，详见 plugins/openclaw 的 agent-cancel-heuristic.js）
		 * - 'cancel-not-supported'：OpenClaw 侧门（embeddedRunState）不存在；plugin 已无法
		 *   主动 abort，UI 主动收尾 run 让用户回到可发送状态（run 仍可能在后台跑）
		 *
		 * @param {string} runKey
		 * @param {'cancel-gone' | 'cancel-not-supported'} reason
		 */
		settleByCancel(runKey, reason) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.ended) return;
			this.__endRun(runId, reason);
		},

		// ============================ 数据维护 ============================

		/**
		 * 去除 streamingMsgs 中的乐观 user 消息——基于锚点范围的存在性判断：
		 * 仅当 server 数据在 anchorMsgId 之后已出现 user message 时才 strip。
		 * 同时把 anchorMsgId 升级到 server 那条 user message 上，避免后续 allMessages
		 * 把残留的 optimisticClaw 错位插到新 user 之前（→ groupSessionMessages 会让
		 * 当前轮 botTask 缺失 _streaming 标记 → 渲染为"任务未完成"）。
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
			let firstUserAfterAnchor = null;
			if (!anchorId) {
				// 无锚点的两种语义：(a) 真正的"首条消息"；(b) register 前 messages=[]（如 activate 失败）。
				// (a) 下 server 第一条 user 就是当次 user；(b) 下却是远古历史 user，升级会让
				// optimisticClaw 锚到错位。这里不升级 anchor，由 allMessages 的"无 anchor → 末尾追加"
				// 兜底分支（对 (a)(b) 都成立）渲染。
				serverHasUserMsg = serverMessages.some((m) => m.message?.role === 'user');
			} else {
				let anchorIdx = -1;
				for (let i = serverMessages.length - 1; i >= 0; i--) {
					if (serverMessages[i].id === anchorId) { anchorIdx = i; break; }
				}
				if (anchorIdx === -1) {
					// 锚点被分页截断 → 视为已持久化；allMessages 因找不到 anchor 会 fallback 到末尾追加
					serverHasUserMsg = true;
				} else {
					for (let i = anchorIdx + 1; i < serverMessages.length; i++) {
						if (serverMessages[i].message?.role === 'user') {
							firstUserAfterAnchor = serverMessages[i];
							break;
						}
					}
					serverHasUserMsg = !!firstUserAfterAnchor;
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
				const nextAnchor = firstUserAfterAnchor?.id ?? anchorId;
				this.runs[runId] = { ...run, streamingMsgs: filtered, anchorMsgId: nextAnchor };
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

		/**
		 * 登出清理：遍历所有 run 走完整 cleanup 流程
		 * 不能用 $reset()：state 替换不会 clearTimeout 已排期的 __timer 和 __watcher.idleTimer。
		 * per-item try/catch：单个 cleanup 抛错（如 URL.revokeObjectURL 边界异常）
		 * 不影响其余 run 的 timer 清理。
		 */
		resetAll() {
			for (const runId of Object.keys(this.runs)) {
				try { this.__cleanupRun(runId, 'logout'); }
				catch (err) { console.debug('[agentRuns] cleanup runId=%s failed: %s', runId, err?.message); }
			}
		},
	},
});
