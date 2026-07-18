# TODO

## 文档引用失效：plugin-sdk-and-runtime.md 引用 CLAUDE.md 不存在的"总纲"（2026-06-10，CLAUDE.md 梳理 review 发现，预存断链）

- `docs/openclaw-research/plugin-sdk-and-runtime.md` 多处引用 CLAUDE.md 的"总纲：gateway RPC > runtime API > SDK > 手搓"——根/plugin 两级 CLAUDE.md 均无此句，引用悬空。
- 修复方向：在合适的 CLAUDE.md（或该文档自身）补全总纲表述，或改写引用为自包含；该优先序原则本身仍有效。

## server 镜像 prisma 引擎的两处遗留耦合（2026-06-08 review 中发现，非活跃 bug，低风险加固）

> 背景：历史上容器启动 `prisma migrate deploy` 因缺引擎二进制去网络下载而卡死数十分钟，已由 commit `33e32153` 修复（构建期把两类引擎都烤进镜像）。下面两条是当时遗留的隐式耦合，平时不犯、但脆弱。

1. **runner 阶段的 libssl3 是靠 curl 顺带拖进来的，没显式装**
   - `server/Dockerfile:30` runner 只 `apt-get install curl`；prisma 的 library 查询引擎（`.so.node`）依赖 libssl3，目前靠 curl→libcurl4→libssl3 间接满足。
   - 风险：哪天为瘦身/换健康检查方式去掉 curl，prisma 引擎就会因缺 libssl 在运行时崩。
   - 便宜加固：runner 阶段显式 `apt-get install -y libssl3`（或 openssl），与 deps 阶段（`Dockerfile:7` 已显式装 openssl）对齐，别依赖传递依赖。

2. **`schema.prisma` 的 `binaryTargets` 是隐式 native，而镜像是多架构构建**
   - `server/prisma/schema.prisma` generator 块未写 `binaryTargets`（默认 `native`）；`scripts/build-server.sh:21` 用 buildx 同时出 `linux/amd64,linux/arm64`。
   - 现状能跑（buildx 每个目标架构在各自模拟环境里跑 `prisma generate`，native 检测出的就是该架构引擎），但属隐式契约：依赖"构建阶段平台检测 == 运行平台"恒成立。
   - 防御式加固（更低优先）：显式钉 `binaryTargets = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x"]`，抗 base 镜像/openssl/buildx 行为漂移。

## electron yauzl 修复深查中发现的预存项（2026-06-08，均与本次 electron/pnpm 改动无关，低优先）

1. **native-run 仍用 yauzl@2.10，理论上也吃 Node 24.16+ 解压回归**
   - 本次只把 electron 的 `extract-zip>yauzl` 顶到 3.x；`@capacitor/cli` 捆的 `native-run` 仍解析 yauzl 2.10.0。
   - 风险 LOW：native-run 不在 APK 构建关键路径（APK 由 Gradle 出），仅 `cap run android` 部署到设备/模拟器时调用；解的是小 APK 而非 281MB 大流（回归对大流式解压最致命）；仓库内无脚本调用它。
   - 真要中招：照搬同款 scoped override `native-run>yauzl: ^3.x` 即可。

## 本机 macOS 下 coturn 容器无法做 WebRTC relay（2026-06-08 定位，已判定暂放）

> 现象：本机 dev 的 coturn 容器能正常起（`ensure-dev-dockers.sh` 全量 `--wait` 0.77s 秒过、RestartCount=0、unless-stopped），但在 macOS 上做不了真正的 WebRTC relay。本机两端（gateway + 浏览器）都在宿主、基本直接走 P2P，relay 用不上，故当前**无实际影响**，暂不修。

- **根因**：colima 默认网络对 published 端口只转 TCP、不转 UDP（实测 mac→容器 UDP 6/6 丢包、TCP 通），且 VM 无宿主可路由 IP。TURN relay 的数据腿必须走 UDP → 容器（在 colima VM 内）的 relay 段宿主够不着，对本机 dev 形同摆设。`deploy/compose.dev.yaml` 的 coturn 用 `network_mode: host` + relay-ip/external-ip 钉死 127.0.0.1，是为 WSL2/Linux 设计；mac+colima 下 host 指 VM 网络，不通。
- **为何暂放**：唯一能让容器版真 relay 的路线 = colima `--network-address`（socket_vmnet 给 VM 可路由 IP），要破坏性重启整个 VM（顺带 down mysql 一次）+ 装 socket_vmnet + sudo 授权 + VM IP 漂移要跟着改 relay-ip。性价比低。
- **将来真要本地 relay 的两条干净退路（择一）**：
  1. Mac 原生 `brew install coturn` bind 127.0.0.1 —— 两端都在宿主、回环即达，完全绕开 colima。
  2. 本机 `server/.env` 指向远端 coturn（`TURN_DOMAIN=im.coclaw.net` / `TURN_PORT` / `TURN_SECRET` 对上远端 static-auth-secret）—— 最省事，但 dev relay 流量绕生产。
- **红线**：别为修 mac 去改 committed 的 `deploy/compose.dev.yaml` coturn 块——mac 上 UDP 也不转发救不了，反而会破坏 Linux/WSL2 现有 `network_mode: host` 路径。

## 文档引用失效：docs/README.md "Product" 段指向不存在的 docs/product/（2026-06-10，skills/commands 梳理 review 发现，预存断链）

- `docs/README.md:74-82` "Product — 产品文档"段列出 7 个 `docs/product/*.md`，但 `docs/product/` 目录不存在，整段为坏指针。
- 修复方向：查 git 史确认这些文档去向（恢复目录或更新路径），否则删除该段。

## release-publish.sh 本地已存在的同名 tag 不核对指向就直接 push（2026-07-18，镜像监控修复的 codex 二审发现，预存风险）

- `scripts/release-publish.sh` tag 段：本地已有 `v<version>` tag 时跳过创建、直接 `git push origin $TAG`。若本地 tag 指向旧 commit 且远端恰好没有该 tag，会把旧 commit 的 tag 推上去、触发对错误 commit 的镜像构建，日志却打印 `tagged & pushed $TAG @ $SHA`（误导为本次 SHA）。
- 镜像监控段此时会因 headSha 不匹配报 WARN「未找到本次 tag 触发的 run」（fail-safe，不会假阳性），但 tag 本身已打错，属发布正确性问题。
- 修复方向：push 前将既有 tag 解引用（`git rev-parse "$TAG^{commit}"`）与 `$SHA` 比对，不一致即非零退出提示人工处置。
- 暂缓理由：属 tag 段预存缺口，与本次镜像监控修复正交（护栏为最小变更未顺手改）；触发前提（本地残留指错的同名 tag 且远端无此 tag）在单人发布流下罕见。

## docs/versioning.md 与 release skill 的 root 版本口径漂移（2026-07-07，R5 skills 打磨终审核实，预存文档不一致）

- `docs/versioning.md` 表格写根包"有变更时 bump / 手动（GitHub Release 时）"；release skill（权威口径）是"A/B 每次必做：root 取所有工作区当前版本的最高"。
- 修复方向：把 versioning.md 该行改为与 release skill 一致，防有人按旧文档反向改回。

## docs/architecture/gateway-agent-rpc-protocol.md 过期，与上游源码相反（2026-07-08，R6 skills 打磨终审核实，预存文档失真）

- ① Status 表 error 行写"ok=true 业务错"，与源码相反（执行失败是 `ok=false` 走 reject）；② "前端实现要点"第 4 条同方向过期、第 5 条 `client.ts:394` 指针漂移（真身在 `openclaw-repo/packages/gateway-client`）；③ status 枚举缺 `in_flight`（幂等去重单帧回包）。
- 该文件属"当前真相"类架构文档，失真会误导后续前端实现；`gateway-agent-rpc` skill 已加过期警示并以 skill 为准，文档本体待按 skill 终态形态表重写。
