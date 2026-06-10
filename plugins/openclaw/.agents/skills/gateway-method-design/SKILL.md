---
name: gateway-method-design
description: 设计/新增 plugins/openclaw 下 gateway RPC method 时的协议契约 + 命名约定 + 错误码 + 历史遗物避坑。Use when 调用 api.registerGatewayMethod、新增或修改 plugin 的 RPC method 入参出参契约时。
---

# OpenClaw Plugin Gateway Method 设计指南

> 给自己（agent）：在 plugins/openclaw 里加/改 `api.registerGatewayMethod` 之前**先读完这页**。详细规则（含方法清单起点）见 `plugins/openclaw/docs/gateway-method-conventions.md`。

## 上游协议契约（强制）

handler 通过注入的 `respond` 函数响应。wire 上是 **ResponseFrame**（`openclaw-repo/packages/gateway-protocol/src/schema/frames.ts` 的 `ResponseFrameSchema`）：

```jsonc
{
  "type": "res",
  "id": "<request id>",
  "ok": true | false,       // 协议层成功/失败
  "payload": <unknown>,     // 业务数据，可选
  "error": {                // 错误结构（ErrorShapeSchema），可选
    "code": "<string>",
    "message": "<string>",
    "details": <unknown>,
    "retryable": <boolean>,
    "retryAfterMs": <integer>
  }
}
```

**`respond` 签名**（`openclaw-repo/src/gateway/server-methods/shared-types.ts` 的 `RespondFn`）：

```ts
respond(
  ok: boolean,        // 协议层成功失败（必填）
  payload?: unknown,  // 业务数据
  error?: ErrorShape, // 错误结构（含 code/message/retryable/retryAfterMs）
  meta?: object       // 元数据
)
```

## 关键事实

1. **协议层已自带 `ok` 标志位 + 独立 `error` 通道**——业务别再造同名字段。
2. **`payload` 是任意 JSON**——协议没有形状约束。
3. **`payload` 不能是 undefined**——上游 CLI `openclaw gateway call --json` 对 `respond(true, undefined)` 抛 `TypeError: ... (reading 'endsWith')`。这是上游 CLI bug 不是协议约束，规避：成功响应即使没数据也用 `{}` 占位。
4. **`respond(false, undefined, err)` 不受这个 bug 影响**——错误路径走 stderr，不读 payload。

## 设计原则

### DO

- **payload 用命名字段对象**——`{ topics: [...] }` 不是裸 `[...]`。理由：扩展性（将来加 `hasMore` / `cursor` 不破坏协议）、语义自描述、永远不会是 undefined。
- **错误走 `error` 通道**——结构化 code + message + retryable，下游能机器读。
- **错误码（新代码）收敛到**：`INVALID_ARGS`（参数校验失败）/ `IO_FAILED`（磁盘/锁/文件操作失败）/ `NOT_FOUND`（业务对象不存在）。`INVALID_INPUT` / `INTERNAL_ERROR` 是早期 handler 的旧契约（file-manager 等既有代码仍在用，不算违规），新模块别延续。
- **handler 必有 `try/catch`**——错误 helper 在模块内自带局部实现（`respondInvalid` / `respondIoFailed`，参考 `src/provider-auth/handlers.js`、`src/model-default/handlers.js` 顶部）。注意：`src/common/errors.js` 没有 respond helper（只有 HTTP 错误文案解析 `resolveErrorMessage`）；`index.js` 里的 `respondError` / `respondInvalid` 是未导出私有函数且用旧契约码，**不可 import**。
- **空响应用 `respond(true, {})`**——不是 `respond(true, undefined)`。
- **method 名用 `coclaw.<resource>.<verb>` 风格**——动词放后缀（`list` / `get` / `set` / `create` / `update` / `delete`），命名留扩展空间（`set` 比 `setPrimary` 好）。

### DON'T

- **不要在 payload 里加 `{ ok: true }` 字段**——协议层 `ok` 已表达；"业务失败"用 `respond(false, undefined, error)` 走 error 通道，不写在 payload。
- **不要把错误信息塞到 payload**——用 `error.code` / `error.message`。
- **不要 `respond(true, undefined)`**——见关键事实 3。
- **不要加 `{ status: <data> }` 外层 wrap**——CoClaw CLI helper 的历史私有约定（非协议要求），2026-05-16 已全库清除；git log 里 wrap 时期的样子**不要照搬作模板**。背景见 conventions doc"历史遗物"节。
- **例外**：**两阶段方法的终态 error 帧合法地在 payload 带 `status`**（如 `respond(false, { status: 'error' }, { code, message })`，模板见上游 `server-methods/agent.ts`）——这是协议正确形态，review 时别拿单发方法的规则误报它。
- **`#` 前缀私有方法别用**——按仓库规范用 `__` 前缀。

## handler 模板

```js
// 模块内局部 helper（参考 provider-auth / model-default 的 handlers.js 顶部）
function respondInvalid(respond, message) {
	respond(false, undefined, { code: 'INVALID_ARGS', message });
}
function respondIoFailed(respond, err) {
	respond(false, undefined, { code: 'IO_FAILED', message: String(err?.message ?? err) });
}

api.registerGatewayMethod('coclaw.foo.create', async ({ params, respond }) => {
	try {
		if (typeof params?.name !== 'string' || params.name.length === 0) {
			respondInvalid(respond, 'name must be a non-empty string');
			return;
		}
		const result = await doCreate(params);
		respond(true, { fooId: result.id }); // 直接业务 payload，无 status wrap
	} catch (err) {
		respondIoFailed(respond, err);
	}
});
```

## Scope

插件注册的方法默认归 `operator.admin`——当前所有调用方（plugin 自身、CLI、server）都持有 admin，无 scope 问题。详见 conventions doc "Scope 与权限"章节。

## Hook + RPC 双实例陷阱（`--link` 安装模式）

`api.on` 注册的 hook 和 `api.registerGatewayMethod` 的 handler **可能跑在不同 ESM 模块实例中**——闭包捕获的状态不能依赖纯内存共享，必须通过磁盘文件中转。详见 conventions doc "Hook 与 Gateway Method 的模块实例隔离"章节。

## 源码锚点速查（按符号 grep，不记行号）

| 主题 | 路径 |
|---|---|
| ResponseFrame / ErrorShape schema | `openclaw-repo/packages/gateway-protocol/src/schema/frames.ts`（`ResponseFrameSchema` / `ErrorShapeSchema`） |
| `respond` 签名 / handler 类型 | `openclaw-repo/src/gateway/server-methods/shared-types.ts`（`RespondFn` / `GatewayRequestHandler`） |
| CoClaw CLI helper（历史 wrap 来源） | `plugins/openclaw/src/common/gateway-notify.js`（`callGatewayMethod`） |
| 局部错误 helper 参考 | `plugins/openclaw/src/provider-auth/handlers.js` / `src/model-default/handlers.js` |
| 详细约定 + 方法清单起点 | `plugins/openclaw/docs/gateway-method-conventions.md` |
