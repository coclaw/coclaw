---
name: coclaw-deploy-web-routing-cache
description: Maintain CoClaw deploy Nginx rules for domain routing, HTTPS redirects, certbot certificate issuance, and SPA/release-artifact cache headers. Use when changing deploy/nginx/ config (modes/*.conf.template, includes/, templates/), or diagnosing browser stale-cache issues after frontend release (especially WeChat Android WebView).
---

# CoClaw Deploy: 域名路由与缓存策略

按以下顺序执行，避免线上行为漂移。

## 1) 先确认目标域名与模板机制

- 应用域名通过 `.env` 的 `APP_DOMAIN` 配置（默认 `im.coclaw.net`）
- Nginx 用 envsubst 模板机制。**真模板在 `deploy/nginx/modes/app-{https,http}.conf.template`**（含全部路由与缓存规则），代理片段在 `deploy/nginx/includes/`（proxy-common / proxy-ws / proxy-sse）；容器启动时 `nginx/scripts/init.sh` 按 `HTTPS_MODE`（auto|custom|off）把对应 mode 模板复制为 `templates/app.conf.template` 再渲染
- `init.sh` 还会幂等创建发布产物目录 `releases/{win,mac,android}`（容器内 html 根下，对应宿主 `~/coclaw/static/releases/`）
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
  - 静态根：该 location 显式 `root /usr/share/nginx/html;` 覆盖 server 级 `ui/current`，指向 init.sh 建的 html 根 `releases/`（缺此行会误落到 `ui/current/releases/`，即历史错配）
- 安全头继承规则：子 `location` 一旦自己 `add_header`，父级安全头不再继承。按现状分层补齐——**HTML 类 location**（`/`、`index.html`）补三件套 `X-Content-Type-Options nosniff` / `X-Frame-Options SAMEORIGIN` / `Referrer-Policy strict-origin-when-cross-origin`；**非 HTML**（`version.json`、`/releases/`）只补 `nosniff`（frame/referrer 头对非 HTML 无意义）。没有 `add_header` 的 location（如 `/assets/`）自然继承父级，不用补

## 3) 证书策略

- 使用 certbot webroot（`/var/www/certbot`）
- certbot 容器使用 compose profiles 控制启停（`auto-https` 续期、`init-cert` 首签）
- 首次签发：`docker compose --profile init-cert run --rm certbot-init`
- `HTTPS_MODE=custom` 时 `init.sh` 若发现证书不存在，会自动生成自签名证书（CN=APP_DOMAIN）占位

## 4) 发布与验证

先测试再重载（在部署机 `~/coclaw` 下执行）：

```bash
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
```

最少验证：

```bash
curl -I https://${APP_DOMAIN}/
curl -I https://${APP_DOMAIN}/version.json
curl -I https://${APP_DOMAIN}/api/v1/auth/session
# /releases/ 落点核实（改过 root 后必验）
curl -I https://${APP_DOMAIN}/releases/win/latest.yml         # 已发布桌面版后期望 200 + no-cache；未发布时返回 404 属正常，不代表修复失败
curl -I https://${APP_DOMAIN}/releases/mac/latest-mac.yml     # 已发布桌面版后期望 200 + no-cache；未发布时返回 404 属正常，不代表修复失败
curl -I https://${APP_DOMAIN}/releases/win/${WIN_INSTALLER}   # ${WIN_INSTALLER} 替换为实际安装包文件名（如 CoClaw-Setup-1.2.3.exe）；已发布桌面版后期望 200 + immutable，未发布时返回 404 属正常
curl -I https://${APP_DOMAIN}/releases/does-not-exist         # 期望 404，而非 SPA index.html(200)
```

检查点：
- HTML / `version.json` 返回 `no-cache, max-age=0, must-revalidate`
- `/assets/` 返回 `max-age=3600`
- `/releases/*/latest*.yml` 返回 200 + `no-cache`；安装包 / blockmap 返回 200 + `immutable`（均需已发布桌面版后才有对应文件；未发布时返回 404 属正常，不代表修复失败）
- 不存在的 `/releases/...` 返回 **404 而非 SPA HTML(200)**——只证 SPA 未兜底 / `/releases/` 前缀隔离成立，**不能证明 root 指向了正确目录**（修复前该 location 本就 `try_files $uri =404` 不回落 SPA，缺失路径改前改后同样 404）；root 覆盖是否真生效，要靠"放一个真实文件到 `static/releases/<平台>/` 后 curl 返回 200"验证（对应已发布桌面版后的 latest.yml=200，或临时探针文件）
- `/api/` 仍可用
- 若缓存头正确但用户仍看到旧版：多半不是缓存而是**服务器发的产物旧**——nginx root 指 `/usr/share/nginx/html/ui/current`；内部部署的 UI 静态根是 `deploy-ui.sh` 生成的 `static/ui/releases/<tag>` + `current` 软链（不在 git），自部署则由 ui-init 容器把 dist 复制成 `current/` **目录**（无 releases/ 属正常）。用 `readlink -f ~/coclaw/static/ui/current` 看真实形态与指向；完整判定流程（含"别信目录名日期"）见 `coclaw-deploy-inspect` skill 的 diagnosis-playbook"前端行为像旧版"一节

## 5) 当前明确不做

- 不启用 HSTS（除非用户明确要求）
