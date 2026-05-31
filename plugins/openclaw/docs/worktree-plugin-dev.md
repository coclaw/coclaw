# worktree 下开发 / 验证插件

> 一句话：在 git worktree 里改插件代码，**活的主网关看不到**——它装的永远是主检出那份。
> 本文给两条验证路子（单测兜底 + 一次性隔离网关）和几条红线。

## 为什么主网关看不到 worktree 的改动（坑 A）

主网关（systemd user service）装的插件是 `openclaw.json` 里 `plugins.load.paths` 指的
`plugins/openclaw/.build/link-stage`，而该 stage 的 `src/` 是一根软链 → **主检出** `src/`
（不是任何 worktree）。所以在 worktree 改 `src/**` + `openclaw gateway restart`，主网关仍跑
主检出代码，worktree 改动不生效。**实测钉死**：同一文件主检出与 worktree 各塞不同 marker、
一次 restart，只有主检出的 marker 进日志。

**坑 A'**：stage 里的 `index.js` / `package.json` / `openclaw.plugin.json` 是 `pnpm deploy`
的**真拷贝**（只 `src/` 是软链，原因见 [`local-plugin-update-sop.md`](local-plugin-update-sop.md)）。
所以改入口 / manifest / 依赖，光 restart 不行，必须重建 stage。

## 坑 B：cwd 重置 → 假绿（plugin / ui / server 通用）

本 agent 环境**每条 Bash 命令结束后 cwd 重置回主检出**。在 worktree 里跑 test / lint / dev，
命令必须**单条** `cd <worktree绝对路径>/<工作区> && <cmd>`，否则命令其实在主检出跑，测出来的绿是
**假绿**（测的是主检出、不是你的 worktree 改动）。这条对 ui / server 同样成立——它们没有坑 A
（按 cwd 跑，进对目录就跑 worktree 码），但都会踩坑 B。

## 方案 A（默认）：单测 + lint，活网关验证留到合回 main

改插件逻辑后，在 worktree 里：

```bash
cd <worktree绝对路径>/plugins/openclaw && pnpm verify   # = lint + test（首次需先 pnpm install）
```

覆盖**不到**的：插件加载边界、register 全量模式、Hook/RPC 双实例软链陷阱、真 RPC 往返、
WebRTC/bridge 端到端。这些要么合回 main 后在主网关验，要么用方案 B。

## 方案 B（需要活网关时）：一次性隔离网关

OpenClaw 原生支持 `--profile <名>`：把 state + config 隔离到 `~/.openclaw-<名>`，与主网关井水不犯河水。
脚本 `scripts/worktree-gateway.sh`（pnpm 别名）把这套自动化，**务必在目标 worktree 内运行**：

```bash
cd <worktree绝对路径>/plugins/openclaw

pnpm wt:up                       # 建本 worktree 独立 stage(src→本 worktree) + 独立 profile + 独立端口前台网关
                                 #   首次自动 pnpm install；输出里有分配到的端口 / profile / log 路径
pnpm wt:call coclaw.info         # 对隔离网关调 RPC（带 --params '<json>' 传参）
# 改了 src/** 后：
pnpm wt:reload                   # 重启隔离网关，src 软链自动跟随，不重 deploy（~3s）
# 改了 index.js / manifest / 依赖：
pnpm wt:up                       # 重跑（重建 stage）
pnpm wt:down                     # 停网关 + 删 profile（用完必做）
```

- profile / 端口从 worktree 目录名派生：同一 worktree 多次操作稳定，不同 worktree 并行互不撞。
- **隔离保证（实测）**：主 `openclaw.json` 全程 md5 不变、主 stage 不动、主网关 pid 不变。
- 不绑定也能验插件加载 + RPC（fresh profile 无 bindings，register 照跑、bridge 自动跳过）。
  只有要验真 bridge / WebRTC 端到端，才往 `~/.openclaw-wt-<名>/coclaw/bindings.json` 补凭据或重新 enroll。

## 红线

- **别在 worktree 里 `pnpm run link`**：它的安装步骤没带 `--profile`，会把**主 config** 的
  `plugins.load.paths` 改指到 worktree 的 stage；等 worktree 删除，主网关配置指向不存在目录 →
  **主网关起不来 / 告警**。worktree 验活网关**只走 `pnpm wt:*`**。
- 用完 **`pnpm wt:down`** 清掉隔离 profile（别留一堆 `~/.openclaw-wt-*`）。
- 删 worktree / 分支前确认提交已合回 main（提交挂在分支上，分支没合就删＝提交真丢）。

## 已知偶发（severity low）

worktree 重构建（`wt:up` 的 install + deploy 合计约 22s）与主网关并跑时，**曾偶发**让主网关收到
SIGTERM 重启一次（systemd `Restart=always` 几秒自愈）。已用对照探针证明**隔离网关本身不扰主网关**
（distinct 端口 + `--force` 只杀目标端口）；根因疑重构建饥饿主网关事件循环触发健康/看门狗，未完全钉死，
见 [`../TODO.md`](../TODO.md)。影响小（自愈），但重构建期间别对主网关做敏感操作。

## 成本（实测，暖 pnpm store）

每 worktree 首次 `pnpm install` ~3.7s + `wt:up` 的 `pnpm deploy` ~18s + 网关起 ~3s；之后改 src 只
`wt:reload` ~3s。日常改逻辑走方案 A（零基础设施）；只有要真网关才付方案 B 这套。

## 相关

- link 模式 / stage 为何只软链 src / 调试日志在哪看：[`local-plugin-update-sop.md`](local-plugin-update-sop.md)
- 双实例软链陷阱：插件 `CLAUDE.md`「Hook / RPC 双实例陷阱」+ [`module-boundaries.md`](module-boundaries.md) §B
