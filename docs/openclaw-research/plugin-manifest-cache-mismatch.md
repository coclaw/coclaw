# OpenClaw 插件清单缓存失配 — status/sessions.list 类 RPC 每次卡 ~10s

> 更新时间：2026-05-11
> 基于 OpenClaw `v2026.5.7`（`commit eeef486449`）本地源码 + bundled dist 验证
> 关联上游 issue：[#80697](https://github.com/openclaw/openclaw/issues/80697)（Open）

## 结论速查

UI 冷启动首屏向 OpenClaw gateway 并发发 9 个 RPC，其中 4 个 RPC（`status`、`models.list`、`sessions.list`、`topics.list`）**每次都卡 ~9.6s**，导致整批 RPC 同步等待。这不是冷启动一次性问题——单独跑 `time openclaw status --json` 每次都 ~11s，第二次跑也一样。

**根因**：`getStatusSummary` 内 `buildSessionRows` 给每个 session 解析 model ref 时，调用链下来不传 `workspaceDir` / `config`，让进程级 plugin manifest snapshot cache 永久 mismatch。每个 session row 都从零重建 manifest snapshot，**70+ session × 2 次（byAgent + allSessions 重复遍历）× ~49ms ≈ 7.3s**。

**本地 workaround**：patch bundled `dist/manifest-model-id-normalization-*.js`，给 `loadManifestModelIdNormalizationPolicies` 加进程级 fallback cache（60s TTL）。验证：CLI status **11s → 3.8s**；UI 首屏 RPC 完成时间 **~10s → ~2.9s**。

## 影响范围

| RPC | 是否中招 | 原因 |
|---|---|---|
| `status` | ✓ 卡 ~9.3s | `buildSessionRows` 在 byAgent + allSessions 各跑一次 |
| `sessions.list` | ✓ 卡 ~9.9s | handler 内调用同款 row resolver |
| `models.list` | ✓ 卡 ~9.4s | 同款 row 化 + 走 model catalog 解析触发同一 manifest 路径 |
| `topics.list` | ✓ 卡 ~9.9s | 同上 |
| `usage.cost` | ✗ 1-3s | 不遍历 session row |
| `tts.status` / `channels.status` / `tools.catalog` | ✗ 1-2s | 不触发 row resolver |

凡是"遍历 session 解析每个 session 用的模型"的 RPC 都会中招；不遍历的不受影响。

## 现象（实测数据）

`openclaw status --json` 注入 `process.hrtime.bigint()` 计时点后：

```
[STATUS-PROF] +707ms   after-runtime-module-import
[STATUS-PROF] +60ms    after-resolveModelAndContextDefaults
[STATUS-PROF] +3957ms  byAgent[main]  buildRows=3956ms n=71
[STATUS-PROF] +53ms    byAgent[tester]  buildRows=53ms n=1
[STATUS-PROF] +53ms    byAgent[xiaoquan] buildRows=53ms n=1
[STATUS-PROF] +3933ms  after-allSessions n=73  ← byAgent 和 allSessions 把 buildSessionRows 重复跑了一遍
[STATUS-PROF-ROWS] calls=146 resolveModelRef=7906ms resolveCtxTokens=0.5ms resolveRuntime=4.6ms
[STATUS-PROF-NPM] calls=147 tStatic=7260ms tLoadRT=0ms tNormRT=0ms
```

`tStatic=7260ms` 是花在 `normalizeStaticProviderModelId` 上的时间——每个 session row 平均 ~49ms 重建插件清单。

CPU 全程烧着（user 7s + sys 5s ≈ wall clock 11s），不是 idle 等 IO。

## 根因调用链

```
buildSessionRows (status.summary.ts)
  ↓ per session
resolveSessionModelRef (status.summary.runtime.ts:148-170)
  ↓
resolvePersistedSelectedModelRef → resolvePersistedModelRef
  ↓
parseModelRef → normalizeModelRef → normalizeProviderModelId (model-selection-normalize.ts)
  ↓
normalizeStaticProviderModelId → normalizeProviderModelIdWithManifest
  ↓
resolveManifestModelIdNormalizationPolicy → loadManifestModelIdNormalizationPolicies (manifest-model-id-normalization.ts)
  ↓
resolveMetadataSnapshotForPolicies({}) — config / workspaceDir 都是 undefined
  ↓
getCurrentPluginMetadataSnapshot({config: undefined, workspaceDir: undefined}) (current-plugin-metadata-snapshot.ts)
```

**关键 guard**（current-plugin-metadata-snapshot.ts）：

```ts
if (snapshot.workspaceDir !== undefined && requestedWorkspaceDir === undefined) {
  return undefined;  // ← 永久命中：snapshot 有 workspaceDir，但调用方不传
}
```

Gateway 启动时通过 `setCurrentPluginMetadataSnapshot(pluginLookUpTable, { config: gatewayPluginConfigAtStart })` 填了 state（`src/gateway/server.impl.ts:666`），fingerprint 计算用了 `options.workspaceDir ?? snapshot.workspaceDir` —— 即把 snapshot 的 workspaceDir 当存储 key。但 `buildSessionRows` 下来的调用永远不传 `workspaceDir`，guard 直接返回 undefined。

回退路径：`loadPluginMetadataSnapshot({config: {}, env, workspaceDir})` 每行重建一次，且 `resolveMetadataSnapshotForPolicies` 返回 `cacheable: false`，连 `cachedPolicies` 这条次级 cache 都不进。

## 上游修复方向（已在 issue #80697 中详述）

- **Option A（最小补丁）**：`loadManifestModelIdNormalizationPolicies` 加进程级 fallback cache，专门处理 `params.config === undefined` 的调用（60s TTL，跟现有 fingerprint cache 同语义）。
- **Option B（更干净）**：把 `cfg` / `workspaceDir` 沿 `resolveSessionModelRef → parseModelRef → normalizeProviderModelId → normalizeStaticProviderModelId → normalizeProviderModelIdWithManifest` 全链路传下来，让原 cache 正常工作。
- **Option C（正交优化）**：`getStatusSummary` 内 `buildSessionRows` 在 `byAgent` 和 `allSessions` 中重复执行一次。即使 cache 修了，每行仍跑两遍。重构成"算一次，切两份视图"能再省一半 resolve 工作。

## 本地 workaround

直接 patch bundled dist（每次 `openclaw` 升级需要重打）：

```bash
F=/home/xhx/.nvm/versions/node/<version>/lib/node_modules/openclaw/dist/manifest-model-id-normalization-*.js
cp "$F" "$F.bak"
```

在 `loadManifestModelIdNormalizationPolicies` 函数前后插入：

```js
let fallbackCachedPolicies = null;
let fallbackCachedAtMs = 0;
const FALLBACK_CACHE_TTL_MS = 60000;

function loadManifestModelIdNormalizationPolicies(params = {}) {
  if (params.plugins) return collectManifestModelIdNormalizationPolicies(params.plugins);
  if (!params.config) {
    const now = Date.now();
    if (fallbackCachedPolicies && (now - fallbackCachedAtMs) < FALLBACK_CACHE_TTL_MS) {
      return fallbackCachedPolicies;
    }
  }
  const { snapshot, cacheable } = resolveMetadataSnapshotForPolicies(params);
  const configFingerprint = snapshot.configFingerprint;
  if (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) return cachedPolicies.policies;
  const policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
  if (cacheable && configFingerprint) cachedPolicies = { configFingerprint, policies };
  if (!params.config) {
    fallbackCachedPolicies = policies;
    fallbackCachedAtMs = Date.now();
  }
  return policies;
}
```

验证：

```bash
openclaw gateway restart
time openclaw status --json > /dev/null   # ~3.8s（原 ~11s）
time openclaw status --json > /dev/null   # ~3.8s
```

JSON 输出对比原版只有 `age` 字段的自然时间差，业务行为完全一致。

## 排查路上几个被推翻的假设（记录避免重复踩）

1. ❌ **"sessions.json 同步整读导致的"** — 实测 main agent 1.2 MB readFileSync + JSON.parse 仅 10ms，三个 agent 总和 ~10ms。
2. ❌ **"usage.cost 冷启动全 transcript 扫描卡 10s"** — 实测 239 文件 / 68MB 串行扫一遍才 ~1.1s，且这条线只卡自己，不卡 status / sessions.list。
3. ❌ **"WSL2 上 statSync 慢 200x，60+ 次 statSync 触发的"** — 实测 WSL2 ext4 上 statSync 0.005ms/次，200 次总和 1.5ms。WSL2 慢 200x 只适用于 `os.networkInterfaces()` 这类被 seccomp 路由到 Windows 宿主的 syscall，不可推广到 fs 系列。
4. ❌ **"CPU profile 99.9% idle = 主线程在同步等 IO"** — 那个 cpu-prof 抓的是 `openclaw status` CLI 进程，**不是 gateway**。`time openclaw status --json` 真实结果是 user 7s + sys 5s ≈ wall clock 11s，CPU 全程烧着。
5. ❌ **"`allowPluginNormalization: false` 能跳过这条路径"** — 这个 flag 只跳过 **runtime** normalization（loadProviderRuntime，实测 0ms），跳不掉 **manifest** normalization（49ms 的真元凶）；只有 `allowManifestNormalization: false` 才会跳，但调用链上没传。

## 关联文档与上游 issue

- 上游 issue：[#80697](https://github.com/openclaw/openclaw/issues/80697)
- 影响 RPC 定义见：[gateway-protocols.md](./gateway-protocols.md)
- 同主题主线程阻塞类问题：[#75069](https://github.com/openclaw/openclaw/issues/75069)（plugin runtime mirror 同步重建）、[#74325](https://github.com/openclaw/openclaw/issues/74325)（gateway 重启 ~75s 阻塞）
