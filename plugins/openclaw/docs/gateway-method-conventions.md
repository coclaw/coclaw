# Gateway RPC 方法注册约定

> 给未来的 agent：本插件向 OpenClaw gateway 注册 RPC method 时遵循的命名 / 错误格式 / scope / 模块实例隔离约定。
> 加新 method 前先看完这页，避免重复踩坑。

## 命名

OpenClaw 把 method 名当**扁平字符串 key**——"."只是约定分隔符，没有路由语义。唯一硬约束：非空、不与已注册的同名。

- 本插件新增 method **统一用 `coclaw.` 前缀**，符合 OpenClaw 官方约定 `pluginId.action`。
- 历史方法 `nativeui.sessions.listAll` / `nativeui.sessions.get` 暂保留，迁移成本不大但没必要为兼容耗费精力——后续若需要重命名走 deprecation flow 即可。

## 错误响应格式

**新格式（统一用这个）**：

```js
respond(false, undefined, { code, message });
```

**旧格式（禁用）**：

```js
respond(false, { error: '...' });   // ❌
```

旧格式把 error 字符串放在 payload 中，下游按"成功响应"解析会拿到一个无意义的 payload + 拿不到结构化 error。已统一在 `common/errors.js` 提供：

- `respondError(respond, err)` — 抓异常→格式化→`respond(false, undefined, { code, message })`。一切 try/catch 走这条。
- `respondInvalid(respond, message)` — 参数校验失败专用，code 固定为 `INVALID_ARGS`。

加新 handler 时模板：

```js
api.registerGatewayMethod('coclaw.foo', async ({ params, respond }) => {
  try {
    if (typeof params?.x !== 'string') {
      respondInvalid(respond, 'x must be a string');
      return;
    }
    const result = await doFoo(params);
    respond(true, result);
  } catch (err) {
    respondError(respond, err);
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

## 限制：插件注册的 method 仅供本插件提供

- **禁止重复注册同名方法**——OpenClaw 不做 namespace 隔离，第二个注册会覆盖或报错（依赖上游版本）。
- 若某个 method 未来要对外暴露或被其他插件复用，先和上游讨论是否升级为 OpenClaw 内置方法。

## 何时来读这份 doc

- 加新 RPC method 之前——拿模板 + 命名前缀。
- 实现 hook + RPC 共享状态的功能——记住 `--link` 双实例陷阱。
- 看到 server 侧调 admin-only method 不报错的反应——这是 bridge 转发的设计，不是 bug。
