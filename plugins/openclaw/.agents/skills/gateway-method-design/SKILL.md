---
name: gateway-method-design
description: 设计/新增 plugins/openclaw 下 gateway RPC method 时的协议契约 + 命名约定 + 错误码 + 历史遗物避坑。Use when 调用 api.registerGatewayMethod、新增或修改 plugin 的 RPC method 入参出参契约时。
---

# OpenClaw Plugin Gateway Method 设计指南

> 给自己（agent）：在 plugins/openclaw 里加/改 `api.registerGatewayMethod` 之前**先读完这页**。详细规则和现存方法清单见 `plugins/openclaw/docs/gateway-method-conventions.md`。

## 上游协议契约（强制）

handler 通过注入的 `respond` 函数响应。wire 上是 **ResponseFrame**（`openclaw-repo/src/gateway/protocol/schema/frames.ts:147`）：

```jsonc
{
  "type": "res",
  "id": "<request id>",
  "ok": true | false,       // 协议层成功/失败
  "payload": <unknown>,     // 业务数据，可选
  "error": {                // 错误结构，可选
    "code": "<string>",
    "message": "<string>",
    "details": <unknown>,
    "retryable": <boolean>,
    "retryAfterMs": <integer>
  }
}
```

**`respond` 签名**（`openclaw-repo/src/gateway/server-methods/shared-types.ts:35`）：

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
3. **`payload` 不能是 undefined**——上游 CLI `openclaw gateway call --json` 对 `respond(true, undefined)` 抛 `TypeError: Cannot read properties of undefined (reading 'endsWith')`。这是上游 CLI bug 不是协议约束，规避：成功响应即使没数据也用 `{}` 占位。
4. **`respond(false, undefined, err)` 不受这个 bug 影响**——错误路径走 stderr，不读 payload。

## 设计原则

### DO

- **payload 用命名字段对象**——`{ topics: [...] }` 不是裸 `[...]`。理由：扩展性（将来加 `hasMore` / `cursor` 等不破坏协议）、语义自描述、永远不会是 undefined。
- **错误走 `error` 通道**——结构化 code + message + retryable，下游能机器读。
- **错误码用统一常量**：
  - `INVALID_ARGS`——参数校验失败
  - `IO_FAILED`——磁盘/锁/文件操作失败
  - `NOT_FOUND`——业务对象不存在
  - 别用 `INVALID_INPUT` / `INTERNAL_ERROR`（既有 helper 用过，但跟 provider-auth 等新代码契约不一致）
- **handler 必有 `try/catch`**——异常走 `respondError(respond, err)`；参数校验失败走 `respondInvalid(respond, msg)`。两个 helper 见 `plugins/openclaw/src/common/errors.js`。
- **空响应用 `respond(true, {})`**——不是 `respond(true, undefined)`。
- **method 名用 `coclaw.<resource>.<verb>` 风格**——动词放后缀（`list` / `get` / `set` / `create` / `update` / `delete`）。
- **命名留扩展空间**——`set` 比 `setPrimary` 好（将来扩字段时不用改方法名）。

### DON'T

- **不要在 payload 里加 `{ ok: true }` 字段**——协议层 `ok` 已表达，重复就是冗余。`{ ok: false }` 表达"业务失败"更不该写在 payload，应该用 `respond(false, undefined, error)` 走 error 通道。
- **不要把错误信息塞到 payload**——用 `error.code` / `error.message`。下游解析"成功响应里的 error 字符串"是糟糕的反模式。
- **不要 `respond(true, undefined)`**——见上文上游 CLI bug。
- **不要加 `{ status: <data> }` 外层 wrap**——这是 CoClaw 历史遗物，详见下文。
- **`#` 前缀私有方法别用**——按 coclaw/CLAUDE.md 规范用 `__` 前缀。

## CoClaw 历史遗物：`{ status: ... }` wrap（已清除）

**早期** CoClaw 6 个走 CLI 入口的 method（`bind` / `unbind` / `enroll` / `providerAuth.*` 三个）handler 把 payload 包成 `{ status: <data> }`——这不是协议要求，而是自家 CLI helper `callGatewayMethod`（`plugins/openclaw/src/common/gateway-notify.js`）历史 unwrap 行为（抽 `.status` 字段交给 CLI 业务用）带来的硬约束。

**2026-05-16 已彻底清除**：6 个 handler 全部去 wrap，helper 改为整体 payload 透传（`result.payload` 直接 = handler `respond(true, X)` 里的 X），CLI registrar 读法同步改成 `result.payload.xxx`。仓库内不再有 wrap 现存例子。

**新方法该怎么写**：

- **不 wrap**——出参直接是纯业务 payload，跟协议契约一致
- **CLI 入口（如果需要）**应该在 CLI registrar 里自己处理出参形态——不该污染 RPC 协议层
- 仓库 git log 能找到 wrap 时期的样子，**不要照搬作模板**

**反例（不要学）**：

```js
// ❌ 别学历史 wrap
respond(true, { status: { profileId } });
respond(true, { status: {} });

// ❌ 别学 topics.delete 这种 ok 冗余
respond(true, { ok: true });
respond(true, { ok: false });  // "业务失败"该走 error 通道
```

**正例**：

```js
// ✅ 命名字段对象，无外层 wrap
respond(true, { profileId });
respond(true, { topics: [...] });

// ✅ 空响应
respond(true, {});

// ✅ 失败走 error 通道
respond(false, undefined, { code: 'INVALID_ARGS', message: 'name required' });
```

## handler 模板

```js
api.registerGatewayMethod('coclaw.foo.create', async ({ params, respond }) => {
  try {
    if (typeof params?.name !== 'string' || params.name.length === 0) {
      respond(false, undefined, { code: 'INVALID_ARGS', message: 'name must be a non-empty string' });
      return;
    }
    const result = await doCreate(params);
    respond(true, { fooId: result.id });   // 直接业务 payload，无 status wrap
  } catch (err) {
    respond(false, undefined, {
      code: 'IO_FAILED',
      message: String(err?.message ?? err),
    });
  }
});
```

或者用既有 helper（推荐）：

```js
import { respondError, respondInvalid } from '../common/errors.js';

api.registerGatewayMethod('coclaw.foo.create', async ({ params, respond }) => {
  try {
    if (typeof params?.name !== 'string' || params.name.length === 0) {
      respondInvalid(respond, 'name must be a non-empty string');
      return;
    }
    const result = await doCreate(params);
    respond(true, { fooId: result.id });
  } catch (err) {
    respondError(respond, err);
  }
});
```

注意：既有 `respondError` 用的是 `INTERNAL_ERROR` code（不是 `IO_FAILED`），跟 provider-auth 等新代码契约不一致。**新代码倾向自带局部 helper** 让 code 收敛到 `INVALID_ARGS` / `IO_FAILED`，参考 `plugins/openclaw/src/provider-auth/handlers.js` 顶部那两个小 helper。

## Scope

OpenClaw 给每个 method 做 scope 分类。**插件注册的方法默认归 `operator.admin`**——当前所有调用方（plugin 自身、CLI、server）都持有 admin，无 scope 问题。详见 `plugins/openclaw/docs/gateway-method-conventions.md` "Scope 与权限"章节。

## Hook + RPC 双实例陷阱（`--link` 安装模式）

`api.on` 注册的 hook 和 `api.registerGatewayMethod` 的 handler **可能跑在不同 ESM 模块实例中**——闭包捕获的状态不能依赖纯内存共享，必须通过磁盘文件中转。详见 `plugins/openclaw/docs/gateway-method-conventions.md` "Hook 与 Gateway Method 的模块实例隔离"章节。

## 源码锚点速查

| 主题 | 路径 |
|---|---|
| ResponseFrame schema | `openclaw-repo/src/gateway/protocol/schema/frames.ts:147` |
| ErrorShape schema | `openclaw-repo/src/gateway/protocol/schema/frames.ts:126` |
| `respond` 签名 | `openclaw-repo/src/gateway/server-methods/shared-types.ts:35` |
| `GatewayRequestHandler` 类型 | `openclaw-repo/src/gateway/server-methods/shared-types.ts:139` |
| CoClaw CLI helper（历史 wrap 来源） | `plugins/openclaw/src/common/gateway-notify.js:100` |
| 既有错误 helper | `plugins/openclaw/src/common/errors.js` |
| 详细约定 + 现存方法清单 | `plugins/openclaw/docs/gateway-method-conventions.md` |
