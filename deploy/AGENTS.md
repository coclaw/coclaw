# AGENTS.md - deploy 目录约束

> 适用范围：`coclaw/deploy` 及其子目录。

## 目标

该目录用于生产/预发布环境的部署编排（Nginx、Certbot、静态站点、容器编排）以及本地开发基础设施。
修改应遵循「最小变更 + 可回滚 + 可验证」。

## 目录结构

```
deploy/
  compose.yaml          # 生产部署
  compose.dev.yaml      # 本地开发（MySQL）
  .env.example                # 统一环境变量模板
  nginx/
    nginx.conf
    app-http.conf.template     # HTTP-only 备选模板（不放在 templates/ 中，避免被自动渲染）
    templates/                 # envsubst 模板，启动时自动渲染到 /etc/nginx/conf.d/
      app.conf.template        # HTTPS 版（默认）
      default.conf.template    # 拦截非法访问
    includes/
      proxy-common.conf
      proxy-sse.conf
      proxy-ws.conf
    ssl/                       # 默认 server 的自签名证书
  certbot/
    scripts/
  static/                     # UI 发布产物（gitignore）
  data/                       # MySQL 数据（gitignore）
```

## Docker 镜像

| 镜像 | 用途 | 来源 |
|------|------|------|
| `ghcr.io/coclaw/server` | 后端服务 | `scripts/build-server.sh` |
| `ghcr.io/coclaw/ui` | UI 静态文件 | `scripts/build-ui.sh` |

## Compose 服务

| 服务 | 说明 | Profile |
|------|------|---------|
| `nginx` | 反向代理 + 静态资源 | 默认 |
| `server` | 后端 API | 默认 |
| `mysql` | 数据库 | 默认 |
| `ui-init` | 从 UI 镜像复制静态文件到 static 目录 | 默认 |
| `certbot-renew` | 证书自动续期 | `auto-https` |
| `certbot-init` | 首次证书签发 | `init-cert` |

`ui-init` 为一次性服务（`restart: "no"`），仅在首次启动或镜像更新后运行。开发者通过 `deploy-ui.sh` rsync 部署，不依赖此服务。

## 域名与站点规则

- 应用域名通过 `.env` 中的 `APP_DOMAIN` 配置
- Nginx 配置使用 `${APP_DOMAIN}` 变量（envsubst 模板机制）
- `/api/` 与 WebSocket 代理仅在应用域名下处理

## HTTPS 模式

- `HTTPS_MODE=auto`：Let's Encrypt 自动签发（公网部署，默认）
- `HTTPS_MODE=custom`：自备证书，放置于 `certbot/conf/live/${APP_DOMAIN}/`
- `HTTPS_MODE=off`：仅 HTTP（内网小团队），使用 `app-http.conf.template`

## 证书策略

- 使用 Let's Encrypt + certbot webroot 模式
- certbot 容器使用 compose profiles 控制启停
- compose.yaml 中 certbot 的环境变量需用 `$$VAR`，避免被 compose 提前展开

## 缓存策略

- SPA 入口（`/`、`/index.html`、路由回落页）：
  - `Cache-Control: no-cache, max-age=0, must-revalidate`
- 哈希资源目录（`/assets/`）：
  - 当前策略：`max-age=3600`（1h）
- 当前阶段**不启用 HSTS**

## Nginx 修改注意事项

- 避免把 `/api/` 的代理配置与静态站点缓存规则混在一起
- `add_header` 在子 `location` 里会影响继承行为；若在 `location` 设置缓存头，需确保必要安全头仍按预期输出
- 新增/修改 redirect 时，统一使用 301，且保留 `$request_uri`
- 模板文件中只使用 `${APP_DOMAIN}` 变量，不要引入其他 envsubst 变量，以免与 nginx 内置变量冲突
- `NGINX_ENVSUBST_FILTER` 是正则过滤器（匹配环境变量名），值为 `APP_DOMAIN` 而非 `$APP_DOMAIN`
- 备选模板（如 `app-http.conf.template`）不能放在 `templates/` 目录中，nginx 会自动渲染该目录下所有 `*.template` 文件

## 发布后验收（最少检查）

1. `docker compose ps` 所有服务运行正常
2. 域名 HTTPS 访问 200
3. 验证缓存头：HTML `no-cache`、`/assets/` `max-age=3600`
4. 验证 API：`/api/v1/auth/session` 正常响应

## 变更原则

- 非必要不改动现有服务拓扑与 compose 服务名
- 非必要不同时改动域名策略与 API 代理逻辑
- 所有变更需可快速回滚（优先保持单文件可回退）
