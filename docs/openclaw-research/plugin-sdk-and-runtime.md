# OpenClaw 给插件的两条供给线：Runtime 注入 vs SDK Import

> 更新时间：2026-05-14
> 基于 OpenClaw 本地源码（`openclaw-repo/`）+ 上游文档（`docs/plugins/sdk-overview.md`、`docs/concepts/openclaw-sdk.md`）交叉验证

---

## 一句话结论

OpenClaw 提供给插件的能力**不止 runtime 注入一种**。除了 gateway 在 `register({ api, runtime })` 时主动注入到插件实例的 runtime 能力外，还有一套需要插件**自己 import 的 SDK 包**——`ensureAuthProfileStore()` 就是 SDK 一侧的公开函数，所有上游自家 provider 插件都直接 import 用。

两条供给线不是替代关系，是分工：

| 线路 | 谁主动 | 暴露形式 | 典型内容 |
|------|--------|----------|---------|
| **Runtime 注入** | gateway 主动塞 | `register({ api, runtime })` 参数 | `api.registerChannel/Provider/Tool/Hook`、`api.registerGatewayMethod`、`api.on(...)`、`logger`、`runtime.config.*`、`runtime.state.*` 等"运行期能力" |
| **SDK Import** | 插件自己 import | npm 包子路径 | 类型契约、纯函数工具、共享常量、auth profile / models / config 等持久化数据的标准读写入口 |

判断"该走哪条"的经验法则：
- 需要在**插件实例生命周期里**才有意义的东西（注册回调、emit 事件、拿当前 agent 实例、查 gateway 状态）→ 走 runtime 注入
- 跨进程/跨调用都成立、本质是**纯函数**或**对磁盘状态文件的标准读写**（auth 凭据、config 解析、schema、ID 算法）→ 走 SDK import

---

## SDK 自身又分两个：App SDK ≠ Plugin SDK

上游 docs 明确把两套 SDK 摆开（`docs/concepts/openclaw-sdk.md`、`docs/plugins/sdk-overview.md`）：

| SDK | 包名 / Import 路径 | 谁用 | 跑在 OpenClaw 进程内/外 |
|-----|--------------------|------|----------------------|
| **App SDK** | `@openclaw/sdk` | 外部脚本、Dashboard、CI、IDE 扩展、其它 App | **外部**，通过 Gateway WebSocket/HTTP 与 OpenClaw 通信 |
| **Plugin SDK** | `openclaw/plugin-sdk/<sub>` | 跑在 OpenClaw 进程里的插件（注册 provider/channel/tool/hook/runtime） | **内部**，与 OpenClaw 同进程，直接 import 函数/类型 |

CoClaw 的 `plugins/openclaw` 是**插件**，所以走的是 Plugin SDK。CoClaw UI / server 那一侧将来如果要在 OpenClaw 外部直接吊 gateway，那条路才用 App SDK。

### 易混点：monorepo 里的 `@openclaw/plugin-sdk` 不是发行通道

OpenClaw 仓库 `packages/plugin-sdk/` 里确实有一个 npm 包叫 `@openclaw/plugin-sdk`，但它在自己 `package.json` 里写着 `"private": true`、`"version": "0.0.0-private"`，只在 monorepo 内部使用。

**对外发行的 Plugin SDK 通道是主包 `openclaw` 自带的子路径 export**——`openclaw-repo/package.json` 的 `exports` 字段里有几十条 `./plugin-sdk/<sub>` 映射到 `./dist/plugin-sdk/<sub>.js`。插件只需要依赖一个包 `openclaw`，然后从 `openclaw/plugin-sdk/<sub>` import 就行。

所以"标准 Plugin SDK import 写法"长这样：

```typescript
import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/provider-auth";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mutateConfigFile, replaceConfigFile } from "openclaw/plugin-sdk/config-mutation";
```

——而不是 `@openclaw/plugin-sdk/provider-auth`，也不是 `@openclaw/sdk/provider-auth`。

---

## 案例钉死：`ensureAuthProfileStore`

它确实是 Plugin SDK 的一份子，证据链：

1. **公开发行通道**：`openclaw-repo/package.json` 的 `exports` 字段把 `./plugin-sdk/provider-auth` 暴露到 `./dist/plugin-sdk/provider-auth.js`（约第 1098 行）。
2. **SDK 入口源码**：`src/plugin-sdk/provider-auth.ts` 第 24-28 行明确 re-export：
   ```ts
   export {
     ensureAuthProfileStore,
     ensureAuthProfileStoreForLocalUpdate,
     updateAuthProfileStoreWithLock,
   } from "../agents/auth-profiles/store.js";
   ```
3. **底层实现**：函数本体在 `src/agents/auth-profiles/store.ts`。SDK 只是稳定的对外门面。
4. **上游 plugin 大量调用**（都走 SDK，不是 runtime 注入）：
   - `extensions/github-copilot/auth.ts`：`import { ensureAuthProfileStore, ... } from "openclaw/plugin-sdk/provider-auth"`
   - `extensions/codex/src/app-server/auth-bridge.ts`：同样姿势，多处调用
   - `extensions/openai/openai-codex-provider.ts`、`extensions/minimax/provider-registration.ts`、`extensions/microsoft-foundry/auth.ts`、`extensions/cloudflare-ai-gateway/index.ts`、`extensions/discord/src/monitor/auto-presence.ts` 等
5. **官方 docs 也用它做示例**：`docs/pi.md:347`
   ```ts
   const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
   ```

历史上它也曾通过 `src/plugin-sdk/agent-runtime.ts` 这个 barrel 暴露，但该 barrel 现在头部明确标 `@deprecated Broad public SDK barrel. Prefer focused agent/runtime subpaths`——新代码统一走 `provider-auth` 这种**窄子路径**。

---

## 怎么找到该 import 哪个子路径

1. 上游文档总览：`openclaw-repo/docs/plugins/sdk-overview.md`，里面强调"Always import from a specific subpath"。
2. 完整子路径目录：`openclaw-repo/docs/plugins/sdk-subpaths.md`（如果想要分组浏览）。
3. 直接查 `openclaw-repo/package.json` 的 `exports` 字段——这是公开 surface 的**唯一权威清单**。
4. 命令行核对：`openclaw-repo/scripts/lib/plugin-sdk-entrypoints.json` 列出编译入口；公开 export 由它减去 `plugin-sdk-private-local-only-subpaths.json` 得到。

---

## 与本插件 CLAUDE.md 的对应

CoClaw `plugins/openclaw/CLAUDE.md` 里有几条硬约束本质上就是在这两条供给线之间做选择：

- **「禁止直接 `import { resolveStateDir } from '@openclaw/plugin-sdk/state-paths'`」**——这不是说 plugin-sdk 不真实存在，而是该 SDK 子路径在 2026-03-16 才公开，比 runtime 注入版（2026-02-19）晚一个月。当前选择走 runtime 注入更兼容老 gateway。等下沉到 SDK 之后未来再切。
- **「`auto-upgrade/state.js` 因被 worker 子进程共用（worker 没 runtime），保留独立的 env 兜底」**——worker 子进程没有 runtime 注入，只能靠 SDK / 直接读环境变量。这也反向印证了 runtime 是注入的，不是全局可用的。
- **「禁止在 auto-upgrade worker 进程中调 remoteLog」**——同理，worker 没 gateway 主连接，bridge 不可用。

简言之：**runtime 是注入的资源**（需要 gateway 给你才有），**SDK 是 import 来的工具**（包在 node_modules 里随时可用）。worker 子进程没人给它注入 runtime，但 SDK 它自己 import 一样能用。

---

## 写新代码时的决策路径

> CLAUDE.md 已有总纲："对 OpenClaw 的操作优先选 gateway RPC > runtime API > plugin SDK > 手搓"。这里展开两条 SDK 路径之间的选择。

需要调 OpenClaw 能力时，按优先级问自己：

1. **gateway 有现成 RPC 吗？**（最稳，跨进程契约，gateway 兜底实现）
2. **runtime 注入里有现成 helper 吗？**（次稳，跟着 gateway 版本走）
3. **Plugin SDK 有公开子路径吗？**（看 `openclaw-repo/package.json` 的 `exports`，找窄子路径 import；只在前两条都没有时用）
4. **都没有 → 评估手搓 vs 改上游**（手搓往往会踩 schema/兼容性坑）

派 subagent 调研 OpenClaw 现成入口时，让它**同时扫**这两条线（gateway RPC 列表 + plugin-sdk `exports` 字段），不要只看 gateway RPC。

---

## 相关文档

- [模型配置心智模型](model-config-mental-model.md) — auth profile / config mutation 等 SDK 入口在该文末尾的"Plugin SDK 入口"一节
- [核心架构](core-architecture.md) — Channel/Agent/Session 三层模型
- [运行时与运维](runtime-and-operations.md) — Agent run 生命周期
- 上游：`openclaw-repo/docs/plugins/sdk-overview.md`、`openclaw-repo/docs/concepts/openclaw-sdk.md`
