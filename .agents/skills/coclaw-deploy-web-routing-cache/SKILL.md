---
name: coclaw-deploy-web-routing-cache
description: Maintain CoClaw deploy Nginx rules for domain routing, HTTPS redirects, certbot certificate issuance, and SPA cache headers. Use when changing deploy/nginx/templates/app.conf.template, deploy/static/ui, or diagnosing browser stale-cache issues after frontend release (especially WeChat Android WebView).
---

# CoClaw Deploy: 域名路由与缓存策略

按以下顺序执行，避免线上行为漂移。

## 1) 先确认目标域名角色

- 应用域名通过 `.env` 的 `APP_DOMAIN` 配置（默认 `im.coclaw.net`）
- Nginx 配置使用 envsubst 模板机制，模板位于 `deploy/nginx/templates/app.conf.template`
- 模板中只使用 `${APP_DOMAIN}` 变量，不要引入其他变量以免与 nginx 内置变量冲突

## 2) 缓存策略（当前标准）

- `index.html` / SPA 入口回落页：
  - `Cache-Control: no-cache, max-age=0, must-revalidate`
- `/assets/`（哈希资源目录）：
  - 当前为 `max-age=3600`（1h）

注意：在子 `location` 设置 `add_header` 时，补齐必要安全头，避免继承丢失。

## 3) 证书策略

- 使用 certbot webroot（`/var/www/certbot`）
- certbot 容器使用 compose profiles 控制启停（`auto-https`、`init-cert`）
- 首次签发：`docker compose --profile init-cert run --rm certbot-init`

## 4) 发布与验证

先测试再重载：

```bash
docker compose exec -T nginx nginx -t
docker compose exec nginx nginx -s reload
```

最少验证：

```bash
curl -I https://${APP_DOMAIN}/
curl -I https://${APP_DOMAIN}/api/v1/auth/session
```

检查点：
- HTML 返回 `no-cache, max-age=0, must-revalidate`
- `/assets/` 返回 `max-age=3600`
- `/api/` 仍可用

## 5) 当前明确不做

- 不启用 HSTS（除非用户明确要求）
