# Gateway RPC 方法注册约定

> 给未来的 agent：本插件向 OpenClaw gateway 注册 RPC method 时遵循的命名 / 错误格式 / scope / 模块实例隔离约定。
> 加新 method 前先看完这页，避免重复踩坑。

## 命名

OpenClaw 把 method 名当**扁平字符串 key**——"."只是约定分隔符，没有路由语义。唯一硬约束：非空、不与已注册的同名。

- 本插件新增 method **统一用 `coclaw.` 前缀**，符合 OpenClaw 官方约定 `pluginId.action`。
- 历史方法 `nativeui.sessions.listAll` / `nativeui.sessions.get` 暂保留，迁移成本不大但没必要为兼容耗费精力——后续若需要重命名走 deprecation flow 即可。

## 成功响应形状

> 一句话：**新方法 payload 直接是纯业务对象，内层命名字段、不加 `{ status: ... }` 外层 wrap、空响应用 `{}`。`{ status: ... }` 是历史遗物，不要照搬**。

### 上游协议契约

handler `respond(ok, payload?, error?, meta?)` 的实际 wire 形态是 ResponseFrame（`openclaw-repo/src/gateway/protocol/schema/frames.ts:147`）：

```jsonc
{ "type": "res", "id": "...", "ok": true|false, "payload": <any>, "error": <ErrorShape> }
```

**协议层关键事实**：
- 已自带 `ok` 标志位 → 业务别在 payload 里加 `{ ok: true }` 冗余字段
- 已有独立 `error` 通道（结构化 code/message/retryable/retryAfterMs）→ 错误别塞 payload
- `payload` 是任意 JSON、没有形状约束 → CoClaw 早期的 `{ status: ... }` 是私有约定不是协议要求（2026-05-16 已全部清除，详见下文）
- `payload` 不能是 undefined → **上游 CLI bug**：`openclaw gateway call --json` 对 `respond(true, undefined)` 抛 `endsWith` TypeError。规避：空响应用 `respond(true, {})`。错误路径 `respond(false, undefined, err)` 不受影响（走 stderr）

### 新方法实操规则

**默认直接返回业务 payload，内层用命名字段对象**：

```js
api.registerGatewayMethod('coclaw.foo.create', async ({ params, respond }) => {
  try {
    if (typeof params?.name !== 'string') {
      respondInvalid(respond, 'name must be a non-empty string');
      return;
    }
    const result = await doCreate(params);
    respond(true, { fooId: result.id });   // ✅ 直接业务 payload，无 status wrap
  } catch (err) {
    respondError(respond, err);
  }
});

// 没有 payload 的成功响应：
respond(true, {});                          // ✅ 空对象占位，绕 CLI bug

// 不要：
respond(true, undefined);                   // ❌ 上游 CLI 崩 endsWith
respond(true, { ok: true });                // ❌ 协议层 ok 已表达
respond(true, { status: result });          // ❌ 历史遗物，新方法别学
respond(true, { error: 'failed' });         // ❌ 错误信息不要塞 payload
```

**内层命名字段对象**——避免裸数组/字符串/数字。理由：扩展性（将来加 `hasMore` / `cursor` 等不破坏协议）、语义自描述、永远不会是 undefined。

```js
// ✅
respond(true, { topics: [...] });
respond(true, { profile: {...} });
respond(true, { default: {...}, agents: {...} });

// ❌ 不推荐
respond(true, [...]);                       // 没扩展空间
respond(true, "ok");                        // 缺乏语义
```

### 历史遗物：`{ status: <data> }` wrap（已清除）

**早期**所有走 CLI 入口的 method 把 payload 包成 `{ status: <data> }`——这不是协议要求，而是 CoClaw 自家 CLI helper `callGatewayMethod`（`common/gateway-notify.js`）历史 unwrap 行为带来的硬约束：helper 当时从 stdout JSON 里抽 `.status` 字段交给 CLI 业务用，handler 配合 wrap 才能让 CLI 拿到数据。

**2026-05-16 已彻底清除**：

- 6 个 wrap method（`coclaw.bind` / `unbind` / `enroll` / `providerAuth.setApiKey` / `providerAuth.list` / `providerAuth.remove`）handler 全部去 wrap，直接返回业务 payload
- helper 行为改为"整个 wire payload 当 `payload` 字段透传"——不再抠 `.status`
- 同包内 CLI registrar 5 处读法从 `result.status.xxx` 同步改成 `result.payload.xxx`
- 整条链路上不再出现 `status` wrap 概念

**外部影响**：因为这 6 个 method 的 wire 形态消费方只有同包内 CLI registrar（server / UI 不调），改造对外行为透明——CLI 用户看到的文字输出、退出码、行为完全保留。`coclaw.upgradeHealth`（自动升级健康检测）本来就是裸返回派，不在改造范围。

**给未来读者**：仓库里再看不到 wrap 现存例子，但 git 历史里能找到。看到 `result.payload.xxx` 即正常路径——helper 返回的 `payload` 字段就是 handler `respond(true, X)` 里 X 的原样。

### 与外部消费者的契约关系

UI / server 通过 WS 直接拿 handler `respond(true, X)` 里的 X 原样——所以新方法的 payload 形态对它们就是 wire 形态。设计 RPC 时**先把 wire 形态想清楚再写 handler**：UI 拿到这个 JSON 形状能否直接渲染？将来扩字段是否破坏向后兼容？字段命名是否自描述？

## 错误响应格式

**新格式（统一用这个）**：

```js
respond(false, undefined, { code, message });
```

**旧格式（禁用）**：

```js
respond(false, { error: '...' });   // ❌
```

旧格式把 error 字符串放在 payload 中，下游按"成功响应"解析会拿到一个无意义的 payload + 拿不到结构化 error。

**例外——两阶段方法的终态 error 帧可带 `payload.status`**：真·两阶段方法（agent run、`providerAuth.loginOauth`）的终态帧合法携带 `payload.status`，error 终态帧也带：`respond(false, { status: 'error' }, { code, message })`（模板见上游 `server-methods/agent.ts`）。这**不是**上面禁用的"error 塞 payload"——结构化 error 仍在第 3 参，`status` 只是终态判别位（中继按 `payload.status !== 'accepted'` 区分中间态/终态）。别拿单发规则把它误报为违规（2026-05-26 OAuth deep-review 三 reviewer 连续误报的根因）。

仓库内**两套 helper 并存**，按 handler 所属模块选用——没必要统一到一处，因错误码语义不同：

- `plugins/openclaw/index.js` 内部 `respondError` / `respondInvalid`：服务 index.js 自身注册的核心 handler（bind/unbind/enroll/topics/files/info/agent.* 等），错误码 `INTERNAL_ERROR` / `INVALID_INPUT`。
- 各模块自带局部 helper：`provider-auth/handlers.js` 与 `model-default/handlers.js` 各自定义 `respondInvalid`(`INVALID_ARGS`) 与 `respondIoFailed`(`IO_FAILED`)，错误码沿用本节硬约束。

`src/common/errors.js` 目前只导出 `resolveErrorMessage`（用户面错误文案的查表 helper），**不导出 respond 类 helper**。新写 handler 时优先用所属模块内的局部 helper；若模块内还没有，参考 provider-auth / model-default 的局部模式复制一份。

加新 handler 时模板（以 model-default / provider-auth 模式为例）：

```js
api.registerGatewayMethod('coclaw.foo', async ({ params, respond }) => {
  try {
    if (typeof params?.x !== 'string') {
      respondInvalid(respond, 'x must be a string'); // INVALID_ARGS
      return;
    }
    const result = await doFoo(params);
    respond(true, result);
  } catch (err) {
    respondIoFailed(respond, err); // IO_FAILED
  }
});
```

## Scope 与权限

OpenClaw 给每个 gateway method 做 scope 分类（见上游 `method-scopes.ts`）。**插件注册的方法默认归 `operator.admin` scope**——OpenClaw 没专门为它分类的话，fallback 到 admin。

当前所有调用方都持有 `operator.admin`：

| 调用方 | 持有 scope 来源 |
|---|---|
| realtime-bridge 自身的 gateway WS 连接 | 显式声明 `scopes: ['operator.admin']` |
| CLI `openclaw gateway call` | 默认 `CLI_DEFAULT_OPERATOR_SCOPES` 含 admin |
| gateway 内部 synthetic client | 含 admin |

**所以当前无 scope 问题**。但有两个推论需要记住：

1. 若未来要让**非 admin scope 的调用方**直接调插件方法，必须向 OpenClaw 上游的 `METHOD_SCOPE_GROUPS` 表注册所需 scope；否则会被 fallback 拦截到 admin。
2. **server 实质拥有 admin 级 gateway 权限**——bridge 以自身 admin 身份转发 server 来的所有请求，server 是受信方。这是设计预期，不是 bug。安全模型是"server-CoClaw 是信任边界，不是 gateway-plugin 边界"。

## Hook 与 Gateway Method 的模块实例隔离

**这一条是 `--link` 安装模式下最阴的陷阱**——直觉上以为 hook 和 RPC handler 共享内存，实测不一定。

### 现象

OpenClaw `--link` 模式下，`api.on()` 注册的 hook 回调和 `api.registerGatewayMethod()` 注册的 RPC handler **可能运行在不同的 ESM 模块实例中**。即使是同一进程、同一次 `register()` 调用、同一份代码——symlink 让 ESM 模块缓存按"解析后 URL"命中不同副本。

### 后果

闭包捕获的对象（如 Manager 实例）看似同一个，**实际是两份独立的内存拷贝**。Hook 修改的 `manager.__cache` 在 RPC handler 看到的是另一份空的。

### 应对

- 跨 hook/RPC 共享的状态**不能依赖纯内存缓存**，必须通过磁盘文件中转。
- 读取侧（如 RPC handler）每次调用前从磁盘重载；写入侧（如 hook）写完磁盘即可，不用通知读取侧。
- 现有 manager（topic / chat-history）就是这套：lazy load + per-write atomic write + 读侧 `__cache.has(agentId) || await load()` 的兜底。

### 防御性 API

`api.on()` 在某些上下文（CLI 模式的 mock API）可能不存在。注册时加守卫：

```js
if (typeof api.on === 'function') {
  api.on('session_start', async (event, ctx) => { /* ... */ });
}
```

## 当前注册的 method（不维护清单，写这里只是给个起点）

具体列表会跟着 commit 漂移。看真值 grep：

```bash
grep -rn "registerGatewayMethod" src --include='*.js' | grep -v test
```

入口都集中在 `index.js` 的 `register(api)` 内。

类别上目前分为：
- **绑定生命周期**：`coclaw.bind` / `coclaw.unbind` / `coclaw.enroll`
- **插件信息**：`coclaw.info` / `coclaw.info.get` / `coclaw.info.patch` / `coclaw.upgradeHealth`
- **session / chat history**：`nativeui.sessions.*`（历史名）/ `coclaw.sessions.getById` / `coclaw.chatHistory.list`
- **topic 管理**：`coclaw.topics.*`
- **agent 控制**：`coclaw.agent.abort`
- **文件浏览**：`coclaw.files.*`
- **provider 认证**：`coclaw.providerAuth.setApiKey` / `coclaw.providerAuth.list` / `coclaw.providerAuth.remove`
- **模型默认**：`coclaw.model.set` / `coclaw.model.list`

## 限制：插件注册的 method 仅供本插件提供

- **禁止重复注册同名方法**——OpenClaw 不做 namespace 隔离，第二个注册会覆盖或报错（依赖上游版本）。
- 若某个 method 未来要对外暴露或被其他插件复用，先和上游讨论是否升级为 OpenClaw 内置方法。

## 何时来读这份 doc

- 加新 RPC method 之前——拿模板 + 命名前缀。
- 实现 hook + RPC 共享状态的功能——记住 `--link` 双实例陷阱。
- 看到 server 侧调 admin-only method 不报错的反应——这是 bridge 转发的设计，不是 bug。
