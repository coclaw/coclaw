# 多 Agent 支持方案

> 状态：Phase 1-3 已实施，Phase 4 待实施
> 创建日期：2026-03-14

## 1. 背景

CoClaw 当前全链路硬编码为 OpenClaw 的 `main` agent。而 OpenClaw 支持在 `agents.list` 中配置多个顶层 agent（与 main 同级），每个 agent 拥有独立的 workspace、session 存储和身份信息。本方案旨在让 CoClaw 支持这些顶层 agent。

**术语约定**：本文中 "agent" 统一指 OpenClaw 的顶层 agent（top-level agent），不含子 agent。

## 2. 术语变更

| 原概念（UI 文案） | 新概念 | 说明 |
|---|---|---|
| 机器人 / Bot | Claw | 代表一个 OpenClaw 实例 |
| （无，隐含为 main） | Agent | 一个 Claw 下可有多个 Agent |

代码层面：`bot` 相关的变量名、store 名、数据库字段**不做重命名**（避免大范围改动），仅修改 UI 文案和 i18n。

## 3. 现有硬编码位置（需改动）

| 层 | 文件 | 硬编码内容 |
|---|---|---|
| UI | `chat.store.js` — `loadMessages()`, `resetChat()`, `__reconcileMessages()` | `agentId: 'main'` |
| UI | `chat.store.js` — `isMainSession` getter | `sessionKey === 'agent:main:main'` |
| UI | `sessions.store.js` — `__fetchSessionsForBot()` | `agentId: 'main'` |
| UI | `MainList.vue` — `botItems` computed | `sessionKey === 'agent:main:main'` |
| UI | `MainList.vue` — `toSessionBadge()` | `key === 'agent:main:main'` |
| UI | `HomePage.vue` — `resolveDesktopRoute()` | `sessionKey === 'agent:main:main'` |
| Plugin | `realtime-bridge.js` — `__ensureMainSessionKey()` | `key = 'agent:main:main'` |

## 4. 可直接使用的 OpenClaw 原生能力

无需在插件侧自实现，通过现有 RPC 透传链路（UI → server → plugin → gateway）直接调用。

| RPC 方法 | 权限 | 作用 |
|---|---|---|
| `agents.list` | READ | 返回所有顶层 agent 列表（含 id, name, identity）及 defaultId |
| `agent.identity.get` | READ | 获取单个 agent 的身份信息（name/avatar/emoji） |
| `agent`（发消息） | WRITE | 已支持 `agentId` 参数指定目标 agent |
| `sessions.resolve` | READ | 检查 sessionKey 是否存在（**不创建**） |
| `sessions.reset` | ADMIN | 创建/重置 session |
| `agents.create` | ADMIN | 创建新 agent |

### 4.1 `agents.list` 返回结构

```json
{
  "defaultId": "main",
  "mainKey": "agent:main:main",
  "scope": "per-sender",
  "agents": [
    {
      "id": "main",
      "name": "OpenClaw",
      "identity": {
        "name": "OpenClaw",
        "emoji": "🦞",
        "avatar": "avatars/openclaw.png",
        "avatarUrl": "data:image/png;base64,..."
      }
    }
  ]
}
```

- `identity` 仅当 agent 配置了 identity 块时才存在
- `avatarUrl` 为 data URI 或 HTTP URL，可直接用于 `<img src>`

### 4.2 Agent 身份 fallback 链

**avatar**：`cfg.ui.assistant.avatar` → `agents.list[].identity.avatar` → `identity.emoji` → `IDENTITY.md Avatar:` → `IDENTITY.md Emoji:` → `"A"`（硬编码默认值）

**name**：`cfg.ui.assistant.name` → `agents.list[].identity.name` → `IDENTITY.md Name:` → `"Assistant"`

**CoClaw UI 实际 fallback（实施后）**：

**name**（label 显示）：
```
agent.identity.get 的 name（resolvedIdentity.name）    ← 最权威，读取 IDENTITY.md
  → agents.list 的 identity.name                       ← config raw 数据
  → botName（仅默认 agent，来自 server 的 refreshBotName）
  → agents.list 的顶层 name
  → agent id（如 "main"、"tester"）
```

**avatar**（图片/图标显示）：
```
agents.list 的 identity.avatarUrl                      ← 仅当为 data: 或 http(s): URL 时使用
  → resolvedIdentity.emoji 或 identity.emoji           ← 文本渲染
  → bot name 首字母 / 默认 SVG 图标
```

> **注意**：`agent.identity.get` 返回的 `avatar` 字段可能是 workspace 相对路径（如 `avatars/bot.png`）或纯文本（如 `"A"`），不能直接用于 `<img src>`。`agents.list` 的 `identity.avatarUrl` 已由 gateway 转为 data URI，可安全使用。UI 侧对 `avatarUrl` 做了 `isRenderableUrl()` 校验（匹配 `data:` 或 `https?://`），非法值不渲染为 img。

### 4.3 `agents.create` 入参

```json
{
  "name": "My Agent",
  "workspace": "/path/to/workspace",
  "emoji": "🔬",
  "avatar": "avatars/research.png"
}
```

返回：`{ ok: true, agentId, name, workspace }`

### 4.4 RPC 透传链路

所有 gateway 原生 RPC 均可通过现有链路直达，无需插件额外注册：

```
UI → WebSocket → server(bot-ws-hub, 透传) → plugin(realtime-bridge, 透传) → gateway
```

server 和 plugin 均不做 method 级路由判断，所有 `req` 类型消息原样转发。旧版本插件同样支持透传。

## 5. 方案设计

### 5.1 Plugin 层

#### 5.1.1 `realtime-bridge.js`：ensure 逻辑调整

`__ensureMainSessionKey()` → `__ensureAgentSession(agentId)`

- 提取为按单个 agentId ensure 的方法
- 去掉 `mainSessionEnsured` 幂等 flag
- 逻辑不变：`sessions.resolve({ key })` → 失败时 `sessions.reset({ key, reason: 'new' })`
- 暴露为 `bridge.ensureAgentSession(agentId)` 供 `index.js` 调用

连接/重连 gateway 成功后的初始化逻辑：
```
gateway connect ok
  → agents.list 获取所有 agent
  → 对每个 agent 调 ensureAgentSession(agentId)
```

#### 5.1.2 `session-manager/manager.js`：`listAll()` 增加 ensure

在 `listAll()` 内部，读取文件前先 ensure 该 agent 的 main session。

实现位置在 `index.js` 的 handler 层（因为 ensure 需要通过 bridge 的 `__gatewayRpc` 走 WS 回环调用 gateway，manager 本身是纯文件操作）：

```js
api.registerGatewayMethod('nativeui.sessions.listAll', async ({ params, respond }) => {
    const agentId = params?.agentId?.trim() || 'main';
    // ensure 该 agent 的 main session（sessions.resolve 几乎总会成功，开销极小）
    await bridge.ensureAgentSession(agentId);
    respond(true, manager.listAll(params ?? {}));
});
```

性能分析：`sessions.resolve` 走本地 loopback WS（`127.0.0.1:18789`），正常情况下 session 已存在（被初始化时创建或被之前的 listAll 调用 ensure 过），resolve 直接返回成功，开销可忽略。仅首次（session 不存在时）才触发 `sessions.reset`。

#### 5.1.3 `listAll()` 入参兼容性设计

| 入参 | 行为 |
|---|---|
| `agentId: 'main'` | 仅 main agent 的 sessions（现有行为） |
| `agentId: 'ops'` | 仅 ops agent 的 sessions |
| 不传 agentId | fallback 到 `'main'`（向后兼容，旧 UI 不受影响） |

后续优化预留：可增加 `agentIds: string[]` 字段，一次性获取多个 agent 的 sessions 并合并返回。当前阶段 UI 按 agent 逐个调用。

#### 5.1.4 向后兼容

- **旧插件 + 新 UI**：旧插件可透传 `agents.list` 到 gateway；`nativeui.sessions.listAll` 传非 main 的 agentId 会 fallback 到 main（不报错，降级体验）
- **新插件 + 旧 UI**：旧 UI 不传 agentId 或传 `'main'`，走现有逻辑，完全兼容

### 5.2 UI 层

#### 5.2.1 新增 `agents.store.js`

```js
state: {
  // { [botId]: { agents: [], defaultId: 'main', loading: false, fetched: false } }
  byBot: {},
}

actions:
  loadAgents(botId)
    // 通过 bot 的 WS 连接调 agents.list（gateway 原生方法，透传）
    // 缓存 agents 数组及 defaultId

getters:
  getAgentsByBot(botId) → agent[]
  getAgent(botId, agentId) → agent | undefined
  // 扁平列表：所有 bot 的所有 agent，附带 botId
  allAgentItems → [{ ...agent, botId, botName, botOnline }]
```

**加载时机**：
- `botsStore.loadBots()` 成功且 WS 连接就绪后，对每个在线 bot 调 `loadAgents(botId)`
- bot 上线（WS 连接建立）时重新加载
- 手动刷新时重新加载

#### 5.2.2 修改 `sessions.store.js`

`__fetchSessionsForBot(botId)` 改为对每个 agent 分别拉取：

```js
async __fetchSessionsForBot(botId) {
    const agentsStore = useAgentsStore();
    const agents = agentsStore.getAgentsByBot(botId);
    // 若 agentsStore 未加载完成，fallback 到 ['main']
    const agentIds = agents.length ? agents.map(a => a.id) : ['main'];

    const results = await Promise.allSettled(
        agentIds.map(agentId =>
            conn.request('nativeui.sessions.listAll', { agentId, limit: 200, cursor: 0 })
        ),
    );
    // 合并所有 agent 的 sessions，附带 botId
    // ...
}
```

#### 5.2.3 修改 `chat.store.js`

**新增辅助方法**：
```js
__resolveAgentId() {
    // 从 sessionKey 解析 agentId：'agent:<agentId>:<rest>' → 取第二段
    if (!this.sessionKey) return 'main';
    const parts = this.sessionKey.split(':');
    return parts.length >= 2 ? parts[1] : 'main';
}
```

**改动点**：
- `loadMessages()`、`__reconcileMessages()`：用 `this.__resolveAgentId()` 替代硬编码 `'main'`
- `resetChat()`：key 改为 `` `agent:${this.__resolveAgentId()}:main` ``
- `isMainSession` getter：改为 `/^agent:[^:]+:main$/` 模式匹配

**不需改动**：`sendMessage()` — 当前已通过 sessionKey/sessionId 隐式确定 agent。

#### 5.2.4 修改 `MainList.vue`

**Group 2（原 bot 列表）→ Agent 列表（按 Claw 分组）**：

```
[Claw 名称]                    ← 分组标题（仅多 Claw 时显示；单 Claw 时不显示标题）
  🦞 Main Agent                ← 每个 agent 一行
  🔬 Research Agent
  ⚙️ Ops Agent
```

`botItems` computed → `agentItems` computed：

```js
agentItems() {
    const allAgents = agentsStore.allAgentItems;
    const sessions = sessionsStore.items;
    return allAgents.map(agent => {
        const mainSessionKey = `agent:${agent.id}:main`;
        const session = sessions.find(
            s => s.botId === agent.botId && s.sessionKey === mainSessionKey,
        );
        return {
            id: `${agent.botId}:${agent.id}`,
            label: agent.identity?.name || agent.name || agent.id,
            avatar: agent.identity?.avatarUrl || null,
            emoji: agent.identity?.emoji || null,
            online: agent.botOnline,
            to: session
                ? { name: 'chat', params: { sessionId: session.sessionId } }
                : '/home',
        };
    });
}
```

**Avatar 展示**：替换 `<img>` 为统一的 avatar 渲染逻辑（或使用 Nuxt UI 的 `UAvatar`），兼容三种模式：

| 条件 | 展示 |
|---|---|
| `avatarUrl` 存在 | `<img :src="avatarUrl">` |
| 仅 `emoji` 存在 | `<span>` 居中文本渲染 |
| 都无 | 默认 SVG 图标或首字母圆形 |

**`toSessionBadge()`**：`key === 'agent:main:main'` 改为 `/^agent:[^:]+:main$/` 匹配。

**Group 3（session 列表）**：暂保持混合展示。通过 sessionKey 解析 agentId，在条目上显示对应 agent 的 emoji 或名称首字母以区分来源。

#### 5.2.5 修改 `ManageBotsPage.vue`（"管理 Claw"页面）

- 页面标题改为"管理 Claw"
- 每个 Claw 卡片内部新增 Agent 列表：
  - 展示该 Claw 下所有 agent（avatar/emoji + 名称）
  - 每个 agent 提供"对话"按钮 → 跳转到该 agent 的主 session
  - Claw 离线时 agent 列表灰显，"对话"按钮 disabled
- 新增"添加 Agent"按钮（详见 5.2.7）

#### 5.2.6 修改 `HomePage.vue`

`resolveDesktopRoute()`：不再只查 `agent:main:main`，改为查 `agentsStore.byBot[botId].defaultId` 对应的主 session。

#### 5.2.7 新增"创建 Agent"对话框

在"管理 Claw"页面的每个 Claw 卡片中，增加"添加 Agent"按钮。点击后弹出对话框（函数式打开，基于 `useOverlay`），包含：

- 顶部：Agent logo 展示区域，支持上传图片
- 表单字段：名称、emoji、workspace 路径等
- 提交后调用 `agents.create` RPC

界面设计充分借鉴 `ref-projects/chat` 参考项目中的 bot 信息展示对话框。

> **TODO**：编辑已有 Agent 的信息（调用 `agents.update` RPC）。入口待定，可考虑在 Claw 卡片的 agent 列表中增加编辑按钮。

#### 5.2.8 i18n 更新

| 原 key | 新文案（zh-CN / en） |
|---|---|
| `layout.addBot` | 添加 Claw / Add Claw |
| `layout.manageBots` | 管理 Claw / Manage Claws |
| `layout.tabs.bots` | Claw / Claws |
| `layout.noBots` | 暂无绑定 Claw / No Claws bound |
| `layout.botOffline` | Claw 已离线 / Claw offline |
| `layout.bindFirst` | 请先绑定 Claw / Please bind a Claw first |
| `chat.noActiveBot` | 未找到可用的在线 Claw / No available online Claw found |
| `chat.botOffline` | Claw 已离线 / Claw offline |
| `chat.botUnbound` | Claw 已解绑 / Claw unbound |
| `bots.*` | 按上下文将"机器人"替换为"Claw" |

新增 key：
| key | zh-CN / en |
|---|---|
| `agents.addAgent` | 添加 Agent / Add Agent |
| `agents.chat` | 对话 / Chat |

### 5.3 Server 层

**无需改动。**

- Bot 表仍代表一个 OpenClaw 实例，结构不变
- `name` 字段由 `refreshBotName()` 从默认 agent 的 `agent.identity.get` 获取，语义上作为 Claw 的显示名称，合理
- Agent 数据来自 OpenClaw 的实时 RPC，不需要在 server 侧持久化
- RPC 透传逻辑无需任何改动

## 6. 时序保证

核心问题：UI 需要先有 session（含 sessionId）才能构造路由导航到 chat 页面。

### 6.1 初始化时序

```
plugin 连接 gateway 成功
  → agents.list 获取所有 agent
  → 对每个 agent ensureAgentSession()        ← 保证 session 存在
  → （此后 UI WS 连接建立，开始请求数据）

UI mounted
  → botsStore.loadBots()
  → agentsStore.loadAgents(botId)             ← 调 agents.list
  → sessionsStore.loadAllSessions()
    → 对每个 agent 调 nativeui.sessions.listAll({ agentId })
      → handler 内 ensure 兜底（正常情况 resolve 直接成功）
      → 返回 session 列表
  → MainList 渲染 agent 条目（此时 session 一定存在）
```

### 6.2 运行期间新增 agent

```
用户在 OpenClaw 侧新增 agent
  → UI 刷新 agentsStore.loadAgents()           ← 发现新 agent
  → sessionsStore.loadAllSessions()
    → nativeui.sessions.listAll({ agentId: newAgentId })
      → handler 内 ensure 触发 sessions.reset  ← 自动创建 session
      → 返回包含新 session 的列表
  → MainList 渲染新 agent 条目
```

ensure 内聚在 `nativeui.sessions.listAll` 的 handler 中，UI 无需感知 ensure 的存在。

## 7. 实施步骤

### Phase 1：Plugin 层改造 ✅

1. `realtime-bridge.js`：提取 `ensureAgentSession(agentId)` 方法，暴露给 index.js
2. `realtime-bridge.js`：连接成功后改为调 `agents.list` + 对每个 agent ensure
3. `index.js`：`nativeui.sessions.listAll` handler 改为 async，调用前 ensure
4. 补充单元测试
5. `pnpm verify` 通过

### Phase 2：UI 数据层 ✅

1. 新增 `agents.store.js`
   - `loadAgents(botId)`：调 `agents.list` 获取列表，再对每个 agent 调 `agent.identity.get` 补充 `resolvedIdentity`
   - `loadAllAgents()`：为所有在线 bot 并行加载
   - getters：`getAgentsByBot`、`getAgent`、`allAgentItems`（扁平列表附带 botId/botName/botOnline）
2. 修改 `sessions.store.js`：`__fetchSessionsForBot` 按 agentsStore 中的 agent 列表分别拉取，fallback 到 `['main']`；保留 `updatedAt` 字段
3. 修改 `chat.store.js`：
   - 新增 `__resolveAgentId()`：从 `sessionKeyById` 或 `sessionsStore.items` 解析 agentId
   - `isMainSession` 改为 `/^agent:[^:]+:main$/` 正则匹配
   - `loadMessages`/`resetChat`/`__reconcileMessages` 使用动态 agentId
4. 修改 `bots.store.js`：连接就绪后先 `loadAgents` 再 `loadAllSessions`
5. 补充单元测试

**实施中发现的问题**：
- `__resolveAgentId()` 最初仅查 `sessionKeyById`，但 `activateSession` 会清空该 map，导致刷新后非 main agent 的 session 消息加载为空。修复：fallback 到 `sessionsStore.items` 查找 sessionKey。

### Phase 3：UI 展示层 ✅

1. 实现 avatar 兼容渲染（avatarUrl/emoji/text fallback，含 `isRenderableUrl` 校验）
2. 修改 `MainList.vue`：
   - `botItems` → `agentItems`（agents 未加载时 fallback 到 bot 列表）
   - session 列表按 `updatedAt` 降序排序
   - session item avatar 根据 sessionKey 解析 agentId 匹配对应 agent 的 emoji/avatarUrl
   - `toSessionBadge` 的 main session 匹配改为正则
3. 修改 `ManageBotsPage.vue`：Claw 卡片内展示 agent 列表 + "对话"按钮
4. 修改 `HomePage.vue`：使用 `agentsStore.byBot[].defaultId` 导航默认 agent
5. i18n 术语更新（机器人→Claw，新增 agents 命名空间）

**实施中发现的问题**：
- Agent name 显示 "main" 而非友好名称（如 "小点"）：原因是 `agents.list` 返回 config raw 数据，不读 IDENTITY.md。修复：`loadAgents` 增加对每个 agent 调 `agent.identity.get` 获取完整 identity（存为 `resolvedIdentity`），label fallback 链优先使用 `resolvedIdentity.name`。后续可在插件侧合并此逻辑以减少 RPC 调用。
- 默认 agent 无 identity 时 name 兜底：使用 `botName`（server 已通过 `agent.identity.get` 刷新到 bot.name），仅限 defaultId 对应的 agent，避免多 agent 时所有 agent 都显示同一名称。

### Phase 4：创建 Agent 功能（待实施）

1. 创建 Agent 对话框组件（借鉴 `ref-projects/chat` 的 bot 信息对话框）
2. 对接 `agents.create` RPC

### TODO

- 编辑已有 Agent 的信息（`agents.update` RPC）
- `nativeui.sessions.listAll` 支持 `agentIds: string[]` 批量获取
- session 列表按 agent 分组展示（当前为混合展示，通过 agent emoji/avatar 区分来源）
- 优化 `agent.identity.get` 调用：当前 UI 侧逐个调用，后续可在插件侧合并到 `agents.list` 响应中，减少 RPC 往返
