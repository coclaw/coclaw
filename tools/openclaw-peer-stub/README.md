# openclaw peer 占位包（dev-only）

`plugins/openclaw` 声明了 `peerDependencies.openclaw`（可选）——这是上游契约：用户用
`openclaw plugins install` 装插件时，OpenClaw 安装器据此建一条 `node_modules/openclaw →
本机 openclaw` 软链，插件入口里的 `import('openclaw/plugin-sdk/*')` 才能在原生加载下解析。

但在**本仓库开发时**，pnpm（默认开 `auto-install-peers`，且不认 `optional`）会把真 openclaw
连同它整棵传递依赖图拖进 `pnpm-lock.yaml`（实测约 2700 行膨胀）。

根 `pnpm-workspace.yaml` 的 `overrides.openclaw` 把这条 peer 重定向到本空壳包：pnpm 满足了
peer，却不会拉真 openclaw 的依赖树（锁文件只增几行）。

**这个包永不被运行时加载**：
- dev 网关用的是 `scripts/_lib.sh` `build_stage` 在 link-stage 里建的、指向本机真 openclaw 的软链；
- 插件单测把 SDK 动态 import 全 mock 掉，碰不到它；
- `overrides` 只在根 `pnpm-workspace.yaml`、不随插件 tarball 发布，**对用户零影响**。

别把它当真依赖用，也别往里加任何代码。
