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

## 第三方插件如何 import Plugin SDK（loader 机制）

> 2026-05-14 钉死。**写新代码前必读**——上一版 CLAUDE.md 上的"禁止 import plugin-sdk" 约束已废除，但导入方式有硬约束。

> **2026-06-02 更新（OpenClaw 2026.5.28 loader 变更，重要）**：本节以下描述的"靠 loader jiti alias 兜底、不依赖 plugin-local `node_modules/openclaw` 软链"的路径**已被上游打破**。2026.5.28（commit `41a92ae4`「perf: resolve native esm plugin sdk imports」）起，loader 对编译成 `.js` 的入口**优先原生加载**（`shouldPreferNativeModuleLoad`：非 Bun 的 `.js/.mjs/.cjs` 一律走 Node `require(esm)`），**绕过 jiti alias**；它配的新 ESM 解析钩子 `Module.registerHooks()` 又要 **Node ≥ 23.4** 才存在（`registerHooks?.()` 在 Node 22 上静默 no-op）。后果：在 Node 22 上，原生加载的入口里 `import('openclaw/plugin-sdk/*')` 走原生 ESM 解析，plugin 目录没有真 `node_modules/openclaw` 就报 `Cannot find package 'openclaw'`。**本仓库的当前对策**（取代历史上"已移除 peer 声明"的做法）：① 重新声明 `openclaw` 为 optional peerDependency——`openclaw plugins install`（npm 来源 / 非 link 拷贝安装）据此建 `node_modules/openclaw → host openclaw` 软链（安装器 `--omit=peer` + 抹掉 openclaw peer 再单独 junction 软链，**零传递依赖**，不会把 openclaw 依赖树装进用户环境）；② dev `--link` 安装**不**自动建链（CLI 跑 `dryRun` 探针就把目录登记进 `plugins.load.paths`，跳过建链的 `afterInstall`），且 install 期安全扫描（`install-security-scan.runtime.ts`，遍历整棵 node_modules 拒绝任何 realpath 超出 install root 的软链，`--dangerously-force-unsafe-install` 不绕过）禁止在 install 时让 stage 带这条外指软链，故由 `scripts/_lib.sh` 的 `ensure_openclaw_link` 在 `openclaw plugins install` **之后**补——重启 / 加载 `plugins.load.paths` 插件 / `plugins doctor` 均**不**重扫，故 post-install 的软链可长期存活；③ pnpm 开发侧锁膨胀（`auto-install-peers` 默认开且不认 `optional: true`，会把真 openclaw + 整棵传递图拖进 lock 约 2700 行）用根 `pnpm-workspace.yaml` 的 `overrides`（`openclaw → link:./tools/openclaw-peer-stub`）空壳重定向摁住（实测锁只增几行；overrides 仅在根、不随插件 tarball 发布、对用户零影响）。下文的 jiti-alias / 正则扫描机制现在只在 **老网关、`.ts` 源码插件、或原生 require 失败回退 jiti** 时仍生效，不再是 `.js` 入口的主路径。

### 一句话结论

第三方插件用 **bare specifier `openclaw/plugin-sdk/<sub>`**（不是 `@openclaw/plugin-sdk/...`），同时在 `package.json` 把 `openclaw` 声明为 **optional peerDependency**。**关键陷阱**：specifier 必须以字符串字面量出现在**插件入口文件**源码里，否则 OpenClaw plugin loader 的 alias 改写不会触发，整张依赖图回退到原生 Node 解析就找不到 `openclaw` 包。

### 上游官方契约

来源：`openclaw-repo/docs/plugins/`：

| 文档 | 关键陈述 |
|---|---|
| `building-plugins.md` "Import conventions"（约 :337-347） | "Always import from focused `openclaw/plugin-sdk/<subpath>` paths"；根桶口 `openclaw/plugin-sdk` 已 deprecated |
| `building-plugins.md` 提交前 checklist（约 :373） | "All imports use focused `plugin-sdk/<subpath>` paths" |
| `dependency-resolution.md`（约 :60-66） | "Plugins that import `openclaw/plugin-sdk/*` declare `openclaw` as a peer dependency" |
| `cli-backend-plugins.md`（约 :47-69） | 示例 `package.json` 含 `"openclaw": "^2026.3.24"` |
| `extensions/discord/package.json` / `extensions/clickclack/package.json` | 实际范例：`peerDependencies: { openclaw: ">=2026.5.10-beta.1" }` + `peerDependenciesMeta.openclaw.optional: true` |

声明 peer 的实际作用：OpenClaw 的 `plugins install/update/doctor` 流程会在 plugin 目录下 reassert `node_modules/openclaw` 符号链（dependency-resolution.md "reasserts plugin-local `node_modules/openclaw` links"）。对 npm/git 安装是这样；**对 local-path 安装（如本插件 `pnpm deploy --prod` 出的 link-stage）是否同样 reassert，文档没明说**——我们走的路径不依赖这条 reassert，靠下一节的 loader alias 兜底。

### Loader Alias 真实机制

OpenClaw plugin loader 不依赖 plugin 自带 `node_modules/openclaw`——它自己有一张 alias map 把 `openclaw/plugin-sdk/<sub>` 直接接到 OpenClaw 安装目录下的 `dist/plugin-sdk/<sub>.js`。alias map 在已安装 OpenClaw 包里（路径形如 `<openclaw-install>/dist/sdk-alias-*.js`，函数 `resolvePluginSdkScopedAliasMap` / `buildPluginLoaderAliasMap`）。

**触发条件**：loader 通过正则扫描"待加载文件"源码、看到 plugin-sdk import 字面量才强制走 jiti（jiti 才会应用 alias），否则回退到原生 Node `require/import`。正则在 `<openclaw-install>/dist/plugin-module-loader-cache-*.js` 第 58 行附近：

```
PLUGIN_SDK_IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])
   (?:openclaw|@openclaw)\/plugin-sdk(?:\/[^"']*)?["']/u
```

正则要求：
- 字面量字符串（单引号 / 双引号都行）；变量传给 `import()` **不匹配**
- 必须在**插件入口文件**源码里——loader 调 `loadPluginModule(safeSource)` 时 `safeSource` = 入口路径，正则只对它生效；进入入口后的依赖图（含 `import './sub/...'` 拉的子模块）由 Node 原生 ESM 接管，jiti 不再插手

### 字面量 vs 变量、入口 vs 子模块

四种写法的实际表现（已在 OpenClaw 主进程实测）：

| 写法 | 在入口文件 | 在子模块 |
|---|---|---|
| `import 'openclaw/plugin-sdk/X'`（静态字面量） | ✅ 通过 | ✅ 通过（因入口已触发 jiti，依赖图被一并 alias） |
| `import('openclaw/plugin-sdk/X')`（动态字面量） | ✅ 通过 | ❌ 失败（子模块源码无 jiti，原生 Node 解析找不到 `openclaw`） |
| `const M='openclaw/plugin-sdk/X'; import(M)`（动态变量） | ❌ 失败 | ❌ 失败 |
| 完全不出现 | — | — |

CoClaw 选静态字面量风险太大（测试环境无 `openclaw` 包时入口加载即崩）。**实际套路**：入口写一个工厂函数 `() => import('openclaw/plugin-sdk/<sub>')`，注入到子模块当 `loadSdk`——字面量在入口源码里满足正则、jiti 改写后 alias 命中 OpenClaw 自家 dist。第一次 RPC 调用时才解析，懒加载惯性也保留。

实际代码骨架：

```js
// plugins/openclaw/index.js（入口）
import { registerProviderAuthHandlers } from './src/provider-auth/index.js';

// register() 内：
registerProviderAuthHandlers(api, {
  loadSdk: () => import('openclaw/plugin-sdk/provider-auth'),  // 字面量必须在这
});
```

```js
// src/provider-auth/index.js（子模块）
export function registerProviderAuthHandlers(api, opts) {
  const loadSdk = opts.loadSdk;                                 // 由入口注入
  // 第一次调用时才解析 SDK：
  const sdk = await loadSdk();
  // ... 用 sdk.upsertAuthProfileWithLock 等
}
```

### 何时优先 SDK、何时优先 runtime

CLAUDE.md 总纲："对 OpenClaw 的操作优先选 gateway RPC > runtime API > plugin SDK > 手搓"。SDK import 和 runtime 注入的关系：

- **runtime 有等价 API**（如 `rt.state.resolveStateDir()`）→ **走 runtime**。对老 gateway 更兼容（state-paths SDK 子路径 2026-03-16 才公开，比 runtime API 2026-02-19 晚一个月；其它子路径也可能存在类似窗口）
- **runtime 没有等价 API**（如 `openclaw/plugin-sdk/provider-auth` 当前确实没 `rt.providerAuth.*`）→ **走 SDK import**。按本节字面量规则做

### 与本插件 CLAUDE.md 的对应（已废除的"禁止 import plugin-sdk"）

上一版 `plugins/openclaw/CLAUDE.md` 有一条：

> ~~禁止直接 `import { resolveStateDir } from '@openclaw/plugin-sdk/state-paths'`~~

这条**已在 2026-05-14 改写**为更精确的规则：

- `resolveStateDir` 这一类**有 runtime 等价**的依然走 runtime（兼容性原因）
- **没有 runtime 等价的**（如 provider-auth）走 SDK import，按本节字面量规则

原版禁令背后的实际原因不是"SDK 不可用"，而是"那个特定子路径上游晚出现了一个月"。现在我们知道 SDK 是公开的、契约稳固的，禁令换成"按场景选择"。

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

- **state-paths 类（有 runtime 等价）走 runtime 注入**——具体见上一节"何时优先 SDK、何时优先 runtime"。原 CLAUDE.md 的"禁止 import plugin-sdk"绝对禁令已在 2026-05-14 废除，改为按场景选择。
- **「`auto-upgrade/state.js` 因被 worker 子进程共用（worker 没 runtime），保留独立的 env 兜底」**——worker 子进程没有 runtime 注入，只能靠 SDK / 直接读环境变量。这也反向印证了 runtime 是注入的，不是全局可用的。
- **「禁止在 auto-upgrade worker 进程中调 remoteLog」**——同理，worker 没 gateway 主连接，bridge 不可用。

简言之：**runtime 是注入的资源**（需要 gateway 给你才有），**SDK 是 import 来的工具**（按字面量规则可在第三方插件里直接调）。worker 子进程没人给它注入 runtime，但 SDK 它自己 import 一样能用——前提是仍满足"字面量在入口"的硬约束（worker 是独立 spawn 子进程、本质是另一份 entry，需要在它自己的入口源码里写字面量）。

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
