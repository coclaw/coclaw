# TODO

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

2. **worktree 网关工具链 `pnpm wt:*` 在 macOS 上跑不起来**
   - `scripts/_lib.sh`（约 line 189 的 `case` 分支）在 macOS 自带 bash 3.2 下解析失败；脚本还用了 Linux-only 的 `ss`/`fuser`，macOS 无这些命令（也无 `timeout`）。
   - 影响：worktree-dev skill 的隔离网关流程在 Mac 上无法直接用（本次验证靠 `lsof` 手动镜像逻辑绕过）。结合正在搭 Mac 开发环境，值得加固（bash 4+ shebang 或语法降级 + 命令探测/替代）。

3. **两个测试套在 macOS 上必挂（Linux CI 全绿）**
   - plugin `file-manager/handler.test.js`：macOS 把 `/var`→`/private/var` 规范化，mkdtemp 沙箱根仍是 `/var`，`validatePath` 判 symlink 越界报 PATH_DENIED；Linux `/tmp` 非软链故 CI 过。
   - ui `electron/tray.test.js`：2 例落在 `process.platform === 'darwin'` 分支调 `setTemplateImage()`，测试 mock 缺该方法；该分支在 Linux CI 永不执行。
   - 影响：`pnpm test` 在 Mac 上恒 exit 1（与代码改动无关）。若要在 Mac 跑提交门禁需补这两处 mock/路径规范化。
