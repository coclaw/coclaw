# OpenClaw 首屏 RPC fanout 主线程独占 — tts.status 同步段 + applyPluginAutoEnable 重算

> 更新时间：2026-05-13
> 基于 OpenClaw `v2026.5.7`（`commit eeef486449`）本地源码 + bundled dist 验证
> 关联上游 issue：[#81355](https://github.com/openclaw/openclaw/issues/81355)（Open）

## 结论速查

UI 浏览器冷启动后，物理 RTC 通道 ~350ms 就建好，但首屏 9 个并发 RPC 全部要 1.3-2.7s 才返回。两个互相独立的根因加起来贡献了 ~2.1s 主线程独占：

- **(A) `tts.status` handler 同步独占主线程 ~1.5s**：声明是 `async`，但函数体内**一行 `await` 都没有**，4 段同步代码（含 `readFileSync` 与 15 个 provider 同步轮询）连续跑完才返回。期间所有同 tick 进入的 sibling handler 都被卡死。
- **(B) `applyPluginAutoEnable` 同输入重算 8 次 ≈ 600ms**：纯函数无缓存，fanout 期间 8 次调用拿到的 `config` 与 `env` 全部是同一对象引用（已用 `WeakMap` 探针钉死），却被反复算同一答案。

修 A：fanout 总耗时降到 ~1.2s（sibling 终于能 overlap）。修 A+B：降到 ~500-700ms。两个 bug 互相独立，可独立修。

## 影响范围

凡是在浏览器/dashboard 首屏一起发出的并发 RPC，全部中招：

| RPC | 是否中招 | 原因 |
|---|---|---|
| `tts.status` | ✓ 卡 ~1.5s | 自身同步段独占主线程（事故源头） |
| `channels.status` | ✓ ENTER 推迟 ~1.5s 等 tts.status 让出 | 被 A 卡住 |
| `status` / `models.list` / `sessions.list` / `usage.cost` | ✓ 各拖到 2.1-2.6s | 自身有 lazy import 头道开销 ~2s，叠加 A 把 microtask 队列堆住 |
| `tools.catalog` × 3 agents | ✓ 串行 ~730ms | 内部 6 次 `applyPluginAutoEnable` 重算（B 的主要贡献者） |
| `channels.status` 内部 | ✓ ~150ms | 内部 2 次 `applyPluginAutoEnable` 重算 |

## 现象（实测数据）

Gateway 刚 `openclaw gateway restart`，单次浏览器刷新触发 fanout，handler 入口/出口注入 `hrtime` 探针：

```
HND sessions.list ENTER          @t0
HND status        ENTER          @t0+1ms
HND models.list   ENTER          @t0+2ms
HND usage.cost    ENTER          @t0+3ms
HND tts.status    ENTER          @t0+5ms

[t0+5ms → t0+1571ms：tts.status 同步段独占主线程 1.5s，期间没有任何 sibling handler 推进]

HND tts.status    RESP +1566ms
HND channels.status ENTER          ← 等 tts.status 让出后才能进
HND tools.catalog ENTER agent=main
HND tools.catalog RESP +186ms
HND tools.catalog ENTER agent=tester
HND tools.catalog RESP +216ms
HND models.list   RESP +2177ms     ← lazy import 已 resolve，但被堵在 microtask 队列里
HND channels.status RESP +646ms
HND status        RESP +2296ms
HND tools.catalog ENTER agent=xiaoquan
HND tools.catalog RESP +224ms
HND usage.cost    RESP +2592ms
HND sessions.list RESP +2662ms
```

**主线程心跳探测器**（每 5ms 一次的 `setTimeout`，gap > 80ms 即报警）在整个 2.7s 窗口内**连续报警**——事件循环全程没让出过。

### tts.status 内部分段

```
TS after getRuntimeConfig         @0.1ms
TS after resolveTtsConfig         @198.8ms   ← 199ms
TS after resolveTtsPrefsPath      @199.0ms
TS after getTtsProvider           @546.0ms   ← 347ms (readPrefs → readFileSync)
TS after getTtsPersona            @546.1ms
TS after resolveTtsAutoMode       @546.3ms
TS after fallbackProviders        @1451.3ms  ← 905ms (15 providers × isConfigured)
TS after providerStates           @1565.8ms  ← 114ms
```

### applyPluginAutoEnable 调用方分布

8 次/fanout（栈抓证据）：

| 调用方 | 次数 | 单次 | 小计 |
|---|---|---|---|
| `channels.status` 入口 + 内部 `getRuntimeSnapshot` | 2 | ~75ms | ~150ms |
| `tools.catalog` × 3 agents（每 agent 经 `ensureStandalonePluginToolRegistryLoaded` + `resolvePluginTools` 各 1 次） | 6 | ~75ms | ~450ms |
| **总计** | **8** | — | **~600ms** |

`WeakMap` 探针给每个 `config` 和 `env` 对象分配 id，8 次都报告 `cfg=#3 env=#2(=process.env)`——同一对象引用，零缓存。

## 根因分析

### (A) tts.status：async 但内部零 await

源码：`src/gateway/server-methods/tts.ts:29`（v2026.5.7）

```ts
"tts.status": async ({ respond, context }) => {
  try {
    const cfg = context.getRuntimeConfig();
    const config = resolveTtsConfig(cfg);                        // 同步 ~200ms
    const prefsPath = resolveTtsPrefsPath(config);
    const provider = getTtsProvider(config, prefsPath);          // readFileSync ~347ms
    const persona = getTtsPersona(config, prefsPath);
    const autoMode = resolveTtsAutoMode({ config, prefsPath });
    const fallbackProviders = resolveTtsProviderOrder(provider, cfg)
      .slice(1)
      .filter((c) => isTtsProviderConfigured(config, c, cfg));   // 15 × isConfigured ~905ms
    const providerStates = listSpeechProviders(cfg).map(/* isConfigured */); // ~114ms
    respond(true, { /* ... */ });
  } catch (err) { /* ... */ }
}
```

`async function` 内部没有 `await`，整段从 ENTER 到 `respond()` 是一段连续的同步代码——Node 事件循环不会在此段中间插入任何 sibling handler 的 microtask。`readPrefs` 走 `readFileSync`（`extensions/speech-core/runtime-api.ts`），是同步 fs I/O；`isTtsProviderConfigured` 串行轮询每个 provider，对 15 个 provider 串行做检查。

### (B) applyPluginAutoEnable：纯函数无缓存

源码：`src/config/plugin-auto-enable.apply.ts:34`（v2026.5.7）

```ts
export function applyPluginAutoEnable(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const candidates = detectPluginAutoEnableCandidates(params);
  return materializePluginAutoEnableCandidates({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
}
```

入参全部是 identity-stable 对象（`getRuntimeConfig()` 返回的 snapshot 在 fanout 窗口内引用不变；`env === process.env`），且函数纯。但实现不缓存任何状态——每次都从头跑 detect + materialize。fanout 8 次调用就重算 8 次同样答案。

## 上游修复方向（已在 issue #81355 中详述）

### (A) 让 tts.status 真正异步

按影响从大到小：

1. `readPrefs` 改 `fs.promises.readFile` 并 `await`，让 handler 至少有几个 yield 点。
2. `fallbackProviders` 和 `providerStates` 都对 15 个 provider 调 `isConfigured`，可改 `Promise.all` 并发。
3. 给 `isConfigured(provider, cfg)` 在单次 `cfg` 引用生命期内加结果缓存——`fallbackProviders` 和 `providerStates` 紧挨着轮询同一批 provider，命中率几乎 100%。
4. 兜底：关键长同步段之间插 `await Promise.resolve()` 让 sibling handler 抢上来。

### (B) applyPluginAutoEnable 加 WeakMap 缓存

```ts
const cache = new WeakMap<object, WeakMap<object, PluginAutoEnableResult>>();

export function applyPluginAutoEnable(params) {
  const config = params.config;
  const env = params.env;
  if (config && env) {
    let inner = cache.get(config);
    if (!inner) { inner = new WeakMap(); cache.set(config, inner); }
    const hit = inner.get(env);
    if (hit) return hit;
    const result = computeAutoEnable(params);
    inner.set(env, result);
    return result;
  }
  return computeAutoEnable(params);
}
```

`WeakMap` 自动随 config 旋转回收，无需 TTL。测得命中率 7/8 = 87.5%。

## 本地 workaround

**暂无**。等上游修。`coclaw` 项目侧不动 OpenClaw dist 产物。

> 注：此前 [#80697](https://github.com/openclaw/openclaw/issues/80697) 的 manifest cache miss 已有本地 dist patch 在跑（`dist/manifest-model-id-normalization-*.js`，60s TTL fallback cache），跟本 issue 互相独立——80697 修的是"每个 session row 重建插件清单"，本 issue 修的是"handler 同步独占 + 同输入重算"。两者叠加被部分用户体感为同一个"首屏慢"，但根因和影响 RPC 集合都不同。

## 排查路上几个被推翻的假设（记录避免重复踩）

1. ❌ **"剩余 3s 卡顿里 1.2s 是 buildSessionRows × 2"** — patch #80697 后实测 buildSessionRows < 15ms，已不是元凶。
2. ❌ **"patch 后第二次冷启动只剩合理 lazy import 开销"** — 实际仍卡 1.3s，残留来自 A 和 B。
3. ❌ **"残留是 Node event loop 调度的固有累加"** — 不是固有，B 的 600ms 是纯重算可消除。
4. ❌ **"tts.status 1.5s 是网络或 lazy import 等待"** — 内部分段证明是连续同步 CPU + sync fs I/O，主线程心跳全程报警。
5. ❌ **"applyPluginAutoEnable 8 次拿到的 config 不同所以没法缓存"** — `WeakMap` 探针证明 8 次都是同一对象引用，可直接缓存。

## 旁路彩蛋

排查途中发现 `openclaw logs --follow` CLI **每 1.16 秒重连 gateway 一次**拉 `logs.tail`，每次 hello-ok 后置 `refreshHealthSnapshot` 触发 `applyPluginAutoEnable`，~50-80ms 同步 CPU。一分钟约 50 次 ≈ 每分钟 2.5 秒 idle 主线程税（4%）。**对 fanout 体验本身无影响**（fanout 期间新连接的 hello 反正排队等不到），但作为 idle 时段常驻税值得记录。已手动关闭。

## 关联文档与上游 issue

- 上游 issue：[#81355](https://github.com/openclaw/openclaw/issues/81355)
- 同主题主线程阻塞类问题：
  - [#80697](https://github.com/openclaw/openclaw/issues/80697)（manifest cache 全 miss，已合本地 workaround）→ [plugin-manifest-cache-mismatch.md](./plugin-manifest-cache-mismatch.md)
  - [#75069](https://github.com/openclaw/openclaw/issues/75069)（plugin runtime mirror 同步重建）
  - [#74325](https://github.com/openclaw/openclaw/issues/74325)（gateway 重启 ~75s 阻塞）
- 影响 RPC 定义：[gateway-protocols.md](./gateway-protocols.md)
