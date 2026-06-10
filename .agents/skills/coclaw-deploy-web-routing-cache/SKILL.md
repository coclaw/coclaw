---
name: coclaw-deploy-web-routing-cache
description: Maintain CoClaw deploy Nginx rules for domain routing, HTTPS redirects, certbot certificate issuance, and SPA/release-artifact cache headers. Use when changing deploy/nginx/ config (modes/*.conf.template, includes/, templates/), or diagnosing browser stale-cache issues after frontend release (especially WeChat Android WebView).
---

# CoClaw Deploy: 域名路由与缓存策略

按以下顺序执行，避免线上行为漂移。

## 1) 先确认目标域名与模板机制

- 应用域名通过 `.env` 的 `APP_DOMAIN` 配置（默认 `im.coclaw.net`）
- Nginx 用 envsubst 模板机制。**真模板在 `deploy/nginx/modes/app-{https,http}.conf.template`**（含全部路由与缓存规则），代理片段在 `deploy/nginx/includes/`（proxy-common / proxy-ws / proxy-sse）；容器启动时 `nginx/scripts/init.sh` 按 `HTTPS_MODE`（auto|custom|off）把对应 mode 模板复制为 `templates/app.conf.template` 再渲染
- `deploy/nginx/templates/default.conf.template` 只是兜底 server（非法 Host 返回 444 + localhost 健康检查），**不含应用路由**，别在这里找缓存规则
- 模板中只使用 `${APP_DOMAIN}` 一个变量（compose 的 `NGINX_ENVSUBST_FILTER: "APP_DOMAIN"` 保护 nginx 内置变量），不要引入其他变量
- 备选模板不能直接放进 `nginx/templates/`——nginx 会自动渲染该目录下所有 `*.template`

## 2) 缓存策略（当前标准；两个 mode 模板要同步改）

- `index.html` 与 SPA 路由回落（`location /`）：`Cache-Control: no-cache, max-age=0, must-revalidate`
- `/version.json`（版本检测文件）：同上 no-cache，确保客户端始终拿到最新版本号
- `/assets/`（哈希资源目录）：`expires 1h`（响应为 `max-age=3600`）
- `/releases/`（Electron 安装包 / APK，按 win|mac|android 分子目录）：
  - `latest*.yml` 版本清单（任意一级子目录深度）：no-cache
  - 安装包 / blockmap（文件名含版本号）：`public, max-age=2592000, immutable`（30d）

注意：子 `location` 一旦自己 `add_header`，父级安全头不再继承——须补齐三件套：`X-Content-Type-Options nosniff` / `X-Frame-Options SAMEORIGIN` / `Referrer-Policy strict-origin-when-cross-origin`。

## 3) 证书策略

- 使用 certbot webroot（`/var/www/certbot`）
- certbot 容器使用 compose profiles 控制启停（`auto-https` 续期、`init-cert` 首签）
- 首次签发：`docker compose --profile init-cert run --rm certbot-init`

## 4) 发布与验证

先测试再重载（在部署机 `~/coclaw` 下执行）：

```bash
docker compose exec -T nginx nginx -t
docker compose exec nginx nginx -s reload
```

最少验证：

```bash
curl -I https://${APP_DOMAIN}/
curl -I https://${APP_DOMAIN}/version.json
curl -I https://${APP_DOMAIN}/api/v1/auth/session
```

检查点：
- HTML / `version.json` 返回 `no-cache, max-age=0, must-revalidate`
- `/assets/` 返回 `max-age=3600`
- `/api/` 仍可用
- 若缓存头正确但用户仍看到旧版：检查部署机 `static/ui/current` 软链真实指向——UI 静态根是 `deploy-ui.sh` 运行时生成的 `static/ui/releases/<tag>` + `current` 软链（不在 git），nginx root 指 `/usr/share/nginx/html/ui/current`

## 5) 当前明确不做

- 不启用 HSTS（除非用户明确要求）
