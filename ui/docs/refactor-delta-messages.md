# 重构：消除虚拟消息，采用 Delta 模式

> 背景：ChatPage 任务完成后界面"抖动"（滚动条上滚再回到底部）。
> 根因：流式内容和持久内容是两套独立数据通道，lifecycle:end 时全量替换 + 清空虚拟状态导致 DOM 大幅重建。

## 核心思路

将流式事件直接以 JSONL 条目格式追加/更新到 `this.messages`，消除虚拟消息概念。
`chatMessages` 计算属性不再拼接虚拟消息，统一走 `groupSessionMessages()` 管线。

## 数据流对比

```
─── 当前 ───────────────────────────────────────────────────
this.messages (server)  ─┐
                         ├→ groupSessionMessages() ─┐
pendingUserMsg           │                          ├→ chatMessages[]
streamingText            ├→ 虚拟消息拼接 ───────────┘
streamingSteps           │
isThinking              ─┘

lifecycle:end → loadSessionMessages() 替换 this.messages
              → 清空虚拟状态
              → DOM 重建 → 抖动

─── 新方案 ──────────────────────────────────────────────────
this.messages (server + local delta)
              ├→ groupSessionMessages() → chatMessages[]
              │   （增加 isStreaming/startTime 标记支持）
              └→ 无虚拟消息拼接

lifecycle:end → 清除 _streaming 标记（DOM 平滑过渡）
              → 后台 reconcile（补齐 server 元信息）
```

## 实施分两步

### Step 1：重构流式状态写入 messages

**ChatPage.vue — data 变更**

删除状态：
- `streamingText` — 文本直接写入 messages 中的 assistant 条目
- `pendingUserMsg` — 用户消息直接追加到 messages
- `isThinking` — 由 messages 中是否存在 `_streaming: true` 的 assistant 条目推断
- `streamingSteps` — tool/thinking 事件直接追加条目到 messages
- `streamingStartTime` — 移入 messages 条目的 `_startTime` 字段

保留状态：
- `streamingRunId`、`streamingTimer`、`sending`、`messages`

**ChatPage.vue — onSendMessage / sendViaAgent**

发送时直接追加 user 条目到 messages：
```js
this.messages = [...this.messages, {
	type: 'message',
	id: `__local_user_${Date.now()}`,
	_local: true,
	message: { role: 'user', content: text, timestamp: Date.now() },
}];
```

思考指示器也变为一个 _streaming assistant 条目：
```js
this.messages = [...this.messages, {
	type: 'message',
	id: `__local_bot_${Date.now()}`,
	_local: true,
	_streaming: true,
	_startTime: Date.now(),
	message: { role: 'assistant', content: '', stopReason: null },
}];
```

**ChatPage.vue — onAgentEvent**

- `assistant` 事件：找到最后一个 `_streaming` 条目，更新其 `message.content = data.text`，设 `stopReason: 'stop'`
- `tool start` 事件：在 streaming assistant 条目之前插入 assistant 中间条目（含 toolCall block），或追加条目
- `tool result` 事件：追加 `_local` + `_streaming` 的 toolResult 条目
- `thinking` 事件：在 streaming assistant 条目中追加/替换 thinking block

关键辅助方法：
```js
// 找到最后一个 _streaming 的 assistant 条目
__findStreamingBotEntry() {
	for (let i = this.messages.length - 1; i >= 0; i--) {
		const e = this.messages[i];
		if (e._streaming && e.message?.role === 'assistant') return e;
	}
	return null;
}
```

每次修改条目内容后需 `this.messages = [...this.messages]` 触发 Vue 响应式。

**ChatPage.vue — chatMessages 计算属性**

简化为：
```js
chatMessages() {
	return groupSessionMessages(this.messages);
}
```

**ChatPage.vue — watch 清理**

删除：
```js
streamingText() { this.scrollToBottom(); },
'streamingSteps.length'() { this.scrollToBottom(); },
```

改为：
```js
'messages.length'() { this.scrollToBottom(); },
```

**ChatPage.vue — clearStreamingState**

不再需要清理 streamingText/streamingSteps/isThinking/pendingUserMsg。
只需清理 streamingRunId、streamingTimer、事件监听。
同时清除 messages 中所有 `_streaming` 标记。

**ChatPage.vue — 失败恢复**

发送失败时，移除 messages 中所有 `_local` 条目（替代清空 pendingUserMsg）。

**session-msg-group.js — 增加 streaming 支持**

`groupSessionMessages` 识别条目上的 `_streaming` 和 `_startTime` 标记：
- `createBotTask(id, entry)` 增加参数，传递 `isStreaming` 和 `startTime`
- 当条目有 `_streaming` 时，botTask 输出 `isStreaming: true`
- 流式 assistant 条目（`stopReason` 为 null 且 content 为空）不产出 resultText（表示"思考中"）
- 在分组过程中，如果任何一个属于 botTask 的条目带 `_streaming`，则整个 botTask 标记为 streaming

**ChatMsgItem.vue — 无需改动**

接口不变：仍读取 `item.isStreaming`、`item.startTime`、`item.resultText` 等。

### Step 2：重构 lifecycle:end，消除抖动

**lifecycle:end 处理改为两阶段**

```js
if (data?.phase === 'end') {
	this.__agentSettled = true;
	this.sending = false;
	this.rpcClient?.off?.('agent', this.onAgentEvent);
	if (this.streamingTimer) { clearTimeout(this.streamingTimer); this.streamingTimer = null; }
	this.streamingRunId = null;

	// ── Phase 1（同步）：清除 streaming 标记 → DOM 平滑过渡 ──
	let changed = false;
	for (const entry of this.messages) {
		if (entry._streaming) {
			entry._streaming = false;
			changed = true;
		}
	}
	if (changed) {
		this.messages = [...this.messages];
	}

	// ── Phase 2（异步）：后台 reconcile ──
	this.rpcClient?.close?.();
	this.rpcClient = null;
	await this.__reconcileMessages();
	// reconcile 失败时保留本地内容（用户至少能看到流式结果）
}
```

**新增 __reconcileMessages 方法**

```js
async __reconcileMessages() {
	try {
		const rpc = await this.ensureRpcClient();
		const list = await rpc.request('nativeui.sessions.listAll', {
			agentId: 'main', limit: 200, cursor: 0,
		});
		const items = Array.isArray(list?.items) ? list.items : [];
		this.sessionKeyById = Object.fromEntries(
			items.filter((i) => i.sessionKey && i.indexed !== false)
				.map((i) => [i.sessionId, i.sessionKey]),
		);
		const result = await rpc.request('nativeui.sessions.get', {
			agentId: 'main',
			sessionId: this.currentSessionId,
			limit: 500, cursor: 0,
		});
		const serverMsgs = Array.isArray(result?.messages) ? result.messages : [];
		// 此时 _streaming 已清除，DOM 已稳定在完成态。
		// server 数据与 local 数据经 groupSessionMessages 后内容一致，
		// 替换只会更新 id/timestamp 等元信息，不会导致视觉抖动。
		this.messages = serverMsgs;
		return true;
	} catch (err) {
		return false;
	}
}
```

为什么 reconcile 替换 messages 不会抖动？
1. _streaming 已在 Phase 1 清除，DOM 已渲染为完成态
2. server 数据经 groupSessionMessages 后的文本/步骤与 local 数据一致
3. 即使 v-for key 变化导致 DOM 重建，内容完全一致，视觉上无感知
4. reconcile 不调用 scrollToBottom（messages.length 可能不变；可加条件判断）

**sendViaAgent 终态处理调整**

终态到达时的清理也改为移除 _local 条目 + 清除 _streaming 标记，而非清空独立状态变量。

### 测试改动要点

- 所有断言 `pendingUserMsg`、`streamingText`、`streamingSteps`、`isThinking` 的用例需重写为断言 `messages` 数组内容
- 所有断言 `chatMessages` 包含 `__pending_user__` / `__streaming__` 的用例需重写为断言 `chatMessages` 输出中的 `_local` / `isStreaming` 属性
- `session-msg-group.test.js` 增加 `_streaming` / `_startTime` 标记的测试用例

## 改动范围

| 文件 | 改动类型 | 估计行数 |
|------|---------|---------|
| `ChatPage.vue` | 主要改动 | ~100 行 |
| `session-msg-group.js` | 小幅扩展 | ~15 行 |
| `ChatMsgItem.vue` | 无改动 | 0 |
| `ChatPage.test.js` | 大量调整 | ~200+ 行 |
| `session-msg-group.test.js` | 小幅扩展 | ~20 行 |

## 技术风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| v-for key 变化导致 DOM 重建 | 中 | reconcile 在 streaming 清除后执行，内容一致，视觉无感知 |
| local 条目格式与 server 不完全一致 | 中 | 单测覆盖 groupSessionMessages 对 local 条目的处理 |
| messages.length watcher 触发频繁 | 低 | scrollToBottom 有 userScrolledUp 守卫 |
| 测试改动量大 | 中 | 逐个重写，保持覆盖率 |
