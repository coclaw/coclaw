---
name: coclaw-deploy-web-routing-cache
description: Maintain CoClaw deploy web/app Nginx rules for domain routing, HTTPS redirects, certbot certificate issuance, and SPA cache headers. Use when changing deploy/nginx/conf.d/{coclaw.conf,www.conf}, deploy/static/{ui,www}, or diagnosing browser stale-cache issues after frontend release (especially WeChat Android WebView).
---

# CoClaw Deploy: 域名路由与缓存策略

按以下顺序执行，避免线上行为漂移。

## 1) 先确认目标域名角色

- 应用域名：`im.coclaw.net`（SPA + `/api/`）
- 官网主站：`gongyanchat.com`
- 其余官网域名统一 301 到主站（保留 `$request_uri`）：
  - `www.gongyanchat.com`
  - `gongyanchat.cn`
  - `www.gongyanchat.cn`

不要把官网规则写进 `coclaw.conf`；官网放 `www.conf`。

## 2) 缓存策略（当前标准）

### 应用站与官网统一规则

- `index.html` / SPA 入口回落页：
  - `Cache-Control: no-cache, max-age=0, must-revalidate`
- `/assets/`（哈希资源目录）：
  - 当前为 `max-age=3600`（1h）

注意：在子 `location` 设置 `add_header` 时，补齐必要安全头，避免继承丢失。

## 3) 证书策略

- 使用 certbot webroot（`/var/www/certbot`）。
- 证书按域分开 `cert-name`：
  - `gongyanchat.com` (+ `www.gongyanchat.com`)
  - `gongyanchat.cn` (+ `www.gongyanchat.cn`)
  - `im.coclaw.net`
- 在签发前，先确保 80 端口对应域名已放行 `/.well-known/acme-challenge/`。

常用命令（远端 deploy 目录）：

```bash
docker compose run --rm --entrypoint certbot certbot-init \
  certonly --webroot -w /var/www/certbot \
  --email "ops@coclaw.net" --agree-tos --no-eff-email \
  --cert-name gongyanchat.com \
  -d gongyanchat.com -d www.gongyanchat.com
```

## 4) 发布与验证

先测试再重载：

```bash
docker compose exec -T nginx nginx -t
docker compose restart nginx
```

最少验证：

```bash
curl -I https://gongyanchat.com/
curl -I https://www.gongyanchat.com/
curl -I https://gongyanchat.cn/test?a=1
curl -I https://im.coclaw.net/
```

检查点：
- 主站 200；别名域名 301 到 `https://gongyanchat.com...`
- HTML 返回 `no-cache, max-age=0, must-revalidate`
- `/assets/` 返回 `max-age=3600`
- 应用域名 `/api/` 仍可用

## 5) 当前明确不做

- 不启用 HSTS（除非用户明确要求）。
