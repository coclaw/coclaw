# CoClaw 部署编排（deploy）

> 适用范围：`coclaw/deploy` 及其子目录。
> 本文件仅包含“相对 CoClaw 根 AGENTS.md 的增量规则”。
> 文中路径除特别说明外均相对仓库根。

## 目标与变更原则

本目录承载生产/预发布环境的部署编排（Nginx、Certbot、静态站点、容器编排）与本地开发基础设施。修改遵循「最小变更 + 可回滚 + 可验证」：

- 非必要不改动现有服务拓扑与 compose 服务名
- 非必要不同时改动域名策略与 API 代理逻辑
- 所有变更需可快速回滚（优先保持单文件可回退）

## 相关资产索引

- `deploy/README.md` — 目录结构、HTTPS 模式、服务管理、UI 发布与回滚的完整说明（部署者视角）
- `docs/operations/deploy-ops.md` — 内部运维补充（磁盘维护、应急操作）
- `.agents/skills/coclaw-deploy-web-routing-cache/` — Nginx 域名路由、缓存头、证书策略的唯一事实源；改 nginx 模板或排查缓存问题前必读
- `.agents/skills/coclaw-deploy-inspect/` — SSH 到部署机取容器日志（只读排查）
- `deploy/docs/dual-ip-deployment-notes.md` — TURNS 双 IP 部署形态与生产配置记录
- `deploy/docs/desktop-releases.md` — 桌面端（Electron）发布产物分发

## 镜像与 Compose

- 镜像构建：`ghcr.io/coclaw/server` ← `scripts/build-server.sh`；`ghcr.io/coclaw/ui` ← `scripts/build-ui.sh`
- 服务清单以 `deploy/compose.yaml` 为准；certbot 由 profiles 控制启停（`auto-https` 续期、`init-cert` 首签）
- `ui-init` 是一次性服务（`restart: "no"`），从 UI 镜像复制静态文件到 static 目录；开发者走 `deploy-ui.sh` rsync 部署，不依赖它
- `deploy/compose.dev.yaml` 供本地开发，含 mysql 与 coturn 两个服务

## TURNS / 双 IP（可选）

coturn 可通过 TURNS（TLS on 443）穿透限制性网络，需独立 IP 或独立主机避开 nginx 的 443。变量开关见 `deploy/.env.example` 的「TURNS / 独立域名模式」段，启动逻辑在 `deploy/scripts/coturn-start.sh`；部署形态与生产配置详见 `deploy/docs/dual-ip-deployment-notes.md`（设计背景参考已归档的 `docs/designs/turn-over-tls.md`）。

## 硬约束

- `compose.yaml` 中 certbot 的环境变量需写 `$$VAR`，避免被 compose 提前展开
- `NGINX_ENVSUBST_FILTER` 是匹配环境变量名的正则，值为 `APP_DOMAIN` 而非 `$APP_DOMAIN`
- 备选模板（如 `app-http.conf.template`）不能放进 `nginx/templates/`——nginx 会自动渲染该目录下所有 `*.template` 文件
- 新增/修改 redirect 统一使用 301，且保留 `$request_uri`
- 不要把 `/api/` 的代理配置与静态站点缓存规则混在一起
- 启用 TURNS 时，发布后验收需确认：coturn 日志 TLS 证书加载成功、`/api/v1/turn/creds` 返回 `turns:` URL
