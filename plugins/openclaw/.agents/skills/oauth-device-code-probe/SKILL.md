---
name: oauth-device-code-probe
description: 只读探针——枚举并驱动上游 OpenClaw provider 的登录逻辑，捕获真实返回（验证 URL/码、note 格式、交互需求、返回结构）而不完成授权、不落凭据、不动现有代码。手动调研工具，仅显式 /oauth-device-code-probe 调用，不自动触发。
disable-model-invocation: true
---

# OAuth / 设备码登录探针

> 这是个**只读调研工具**，不是产品代码。用来回答一类问题：上游某个 provider 的登录流，
> 在不真正登录的前提下，到底会**亮出什么**（验证 URL、短码、提示文案）、**要不要用户打字**、
> **返回结构长什么样**——以及这些在多家 provider 之间是否**归一化（格式一致）**。
>
> 它被设成 `disable-model-invocation: true`：Claude 不会自动触发，只有你打 `/oauth-device-code-probe` 才加载。

脚本：本目录 `probe.mjs`。

## 它解决的根问题

CoClaw 想"不自己手写复刻各家登录、而是驱动上游 provider 插件已有的登录逻辑"。要拍这个架构，先得知道：
上游那些登录方法的**真实输出**是不是统一的——如果统一，一套通用抠取就够；如果不统一，就得分家适配。
靠读源码只能看个大概（措辞、字段会变），**真相要跑出来看**。这个探针就是干这个的。

## 方法核心（三件套）

1. **枚举 + 按 kind 筛候选**：经 openclaw 包自己的 `exports` 解析出 `resolvePluginProviders`，列出全部 provider，
   读每个 provider 的 auth 方法的 `kind`（`oauth` / `api_key` / `token` / `device_code` / `custom`），按需筛。
   设备码家族 = `kind === 'device_code'`（亮码+后台轮询、用户输入只发生在 provider 官网、零回传）。
2. **捕获型假上下文（fake ctx）**：给登录方法喂一个只会"输出、不会要输入"的环境——
   - 展示类调用（note / progress / plain）→ 记录全文；
   - 交互类调用（text / select / multiselect）→ **被调到就抛"需要交互"**（说明这家不纯输出、装不进两阶段）；
   - confirm（如"已登录是否重登"）→ 默认答 true，放行继续拿码；
   - `isRemote: true`（走远端语义，多数 provider 会跳过本地开浏览器、把码塞进 note）；
   - runtime / openUrl / oauth 给空桩。
3. **哨兵中断**：在"亮出**含 URL 的验证 note**"那一刻抛哨兵解栈，**绝不进入轮询 = 绝不完成授权**。
   网络只到各家 usercode/device 端点拿一次码即停（读操作）。

## 怎么跑

```bash
# 默认：筛 device_code，结果写当前目录的 oauth-device-code-probe-result.json
node plugins/openclaw/.agents/skills/oauth-device-code-probe/probe.mjs --out tmp/probe-result.json

# 改筛别的 kind（看全景用 all）
node .../probe.mjs --kind all
node .../probe.mjs --kind oauth

# 只跑某个 provider
node .../probe.mjs --provider openai-codex
```

- 在**任意能让 `npm root -g` 命中全局 openclaw 的环境**里跑即可（脚本自己定位 gateway 实际用的那份 openclaw 包，不依赖本仓库 `node_modules`）。
- stderr 打进度，stdout 打人类可读小结，完整结构落 `--out`（不给则当前目录；写不动退到系统临时目录，绝不丢）。

## 怎么读结果

- `landscape`：每个 provider 的 auth 方法 + kind —— 用来做"自动候选筛选"（哪些是 device_code）。
- `probed[]`：每个被驱动方法的实测，重点看：
  - `outcome.status`：`verification-note-captured`（成功亮出验证信息）/ `needs-interactive-input`（要打字，装不进两阶段）/ `timeout-no-url-note-30s` / `error`。
  - `verificationNote`：**含 URL 的那条 note 全文 + 抠出的 URL** —— 比对跨家格式是否一致就看这个。
  - `promptCalls`：交互型 prompter 被调几次（理想是全 0）。
  - `viaRunSettled`：run 最终是 resolve 还是 reject（见下面的坑）。

## 实测中沉淀的坑（写代码时务必记住）

1. **不是"第一条 note"就是验证信息**。有的 provider 先来一条无 URL 的前导语（"即将打开登录页…"），
   真正的 URL+码在**后面那条**。所以判定按"**含 URL**"，不按"第一条"。本脚本已这么做。
2. **有的 provider 的 run 会把中途失败吞成空结果**（返回空 profiles，而不是抛异常）。
   所以判"是否亮出了验证信息"要看**有没有捕获到含 URL 的 note**，不能看 run 抛没抛/返回啥。
   下游接入时：**拿到空 profiles 要当失败处理，别当成功**。
3. **跑这脚本 = 把全部 provider 在本进程加载+登记一遍**（有副作用、约数秒）。
   它是【进程外】只读探针——**别在生产 gateway 进程里直接 import 这套**来做轻量查询。
   （这也顺手验证了"进程外加载会触发 fallback load"这件事；但"在运行中的 gateway 内重复加载/登记安不安全"这条，进程外测不出来，要在 gateway 内另测。）
4. **网络只读、点到为止**：只拉一次 usercode/device 码就靠哨兵停住，绝不轮询到完成、绝不建凭据。

## 一次实测快照（2026-05-27，仅参考，重跑为准）

> ⚠️ 下面的数字/名单会随上游版本变，是"那次跑出来长这样"，**不是契约**。要最新结论就重跑。

- 当时 52 个 provider，**只有 4 个 device_code 方法**（不是早先猜的 ~10）：
  `github-copilot:device`、`minimax-portal:oauth`(global)、`minimax-portal:oauth-cn`、`openai-codex:device-code`。
  其余多是 `api_key`；回环类（`chutes`/`google-gemini-cli`/`openai-codex:oauth`）是 `oauth` kind，远端用不了，不在设备码家族。
- **note 格式不统一**（核心结论：上游没归一化）：
  - codex + copilot：行式，`URL: <url>` 一行、`Code: <code>` 一行；URL 是裸登录页，码要用户另外敲。
  - minimax：散文式，URL 内联在句子里，且 **URL 自带 `?user_code=` 短码**。
- 4 个全程**零交互**（promptCalls 全 0），装得进现有两阶段机制。
- codex 当时换回了有效短码（账号/服务器没挡设备码登录）。

## 红线小抄

- 不动现有代码（其他终端可能并行开发）；这只是 tmp 级调研工具的"留档版"。
- 不完成授权、不落凭据、网络只读到拿码即停。
- 不在生产 gateway 进程里 import 这套做查询。
