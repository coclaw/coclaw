# CoClaw 部署指南

## 快速开始（自部署）

从 [GitHub Release](https://github.com/coclaw/coclaw/releases) 下载 `coclaw-deploy.tar.gz`，解压后：

```bash
cd coclaw
cp .env.example .env
# 必须修改：SESSION_SECRET（openssl rand -base64 32）
# 必须修改：APP_DOMAIN（你的域名）
docker compose --profile auto-https up -d
```

## 目录结构

```
coclaw/                              # 部署根目录（远端为 ~/coclaw）
  compose.yaml                       # 生产部署
  compose.dev.yaml                   # 本地开发（仅 MySQL）
  .env.example                       # 环境变量模板
  .env                               # 实际配置（不入库）
  nginx/
    nginx.conf                       # nginx 主配置
    templates/                       # envsubst 模板（启动时自动渲染）
      app.conf.template              # HTTPS 版（默认）
      default.conf.template          # 拦截非法访问
    app-http.conf.template           # HTTP-only 备选（不在 templates/ 中）
    includes/                        # 代理配置片段
    ssl/                             # default server 自签名证书
  certbot/
    scripts/                         # 证书签发与续期脚本
    conf/                            # 证书存储（不入库）
    www/                             # ACME 挑战目录（不入库）
  static/                            # UI 发布产物（不入库）
    ui/current -> releases/<version> # 符号链接指向当前版本
  data/                              # 运行时数据（不入库）
    mysql/                           # MySQL 数据目录
```

## 环境配置

```bash
cp .env.example .env
```

必须修改的项：
- `APP_DOMAIN` — 你的域名
- `SESSION_SECRET` — 随机字符串（`openssl rand -base64 32`）

可选修改：MySQL 密码（默认值可直接使用，仅 Docker 内网可达）。

## HTTPS 模式

| 模式 | 场景 | 操作 |
|------|------|------|
| `auto` | 公网，Let's Encrypt（默认） | 设置 `CERTBOT_EMAIL`，启动加 `--profile auto-https` |
| `custom` | 自备证书（企业 CA / 自签名） | 证书放到 `certbot/conf/live/${APP_DOMAIN}/`，需包含 `fullchain.pem` 和 `privkey.pem` |
| `off` | 仅 HTTP（内网小团队） | 将 `nginx/app-http.conf.template` 复制为 `nginx/templates/app.conf.template`（替换原文件） |

`--profile auto-https` 会启动 certbot 续期容器，每 12 小时自动检查证书到期并续期。不加该 profile 则 certbot 不启动。

## 首次证书签发（HTTPS_MODE=auto）

```bash
# 确保 80 端口可从公网访问
docker compose up -d nginx mysql server     # 先启动（不含 certbot）
docker compose --profile init-cert run --rm certbot-init
docker compose --profile auto-https up -d   # 加入 certbot 续期
```

## 服务管理

```bash
# 启动全部服务（含 certbot 续期）
docker compose --profile auto-https up -d

# 仅重启 server（不影响其他服务）
docker compose up -d server

# 查看服务状态
docker compose --profile auto-https ps

# 查看日志
docker compose logs server --tail 50
docker compose logs nginx --tail 50
```

## UI 静态资源

UI 是纯静态资源，由 nginx 直接提供，**更新无需重启任何容器**。

自部署用户无需额外操作——`docker compose up -d` 时，`ui-init` 服务会自动从 `ghcr.io/coclaw/ui` 镜像复制 UI 文件。更新 UI 只需：

```bash
docker compose pull ui-init
docker compose up -d ui-init   # 复制新文件
```

开发者通过 `deploy-ui.sh` rsync 部署，使用符号链接管理版本（`static/ui/current -> releases/<version>`），支持快速回滚。

## Server 回滚

```bash
# 回滚到指定版本
docker compose pull server    # 或指定 tag: 编辑 compose.yaml 中的 image 版本
docker compose up -d server
```

## 数据存储

MySQL 数据通过 Docker volume 的 bind mount 存储在 `data/mysql/`。如果服务器有独立的数据盘，建议将 `data/` 替换为指向数据盘的符号链接：

```bash
# 示例：将 data 目录指向 /data 盘
mv data /data-bak
ln -s /data data
mv /data-bak/mysql /data/mysql
```

`.env` 中的 `MYSQL_DATA_PATH=./data/mysql` 无需修改。

---

## 开发者部署（需完整仓库）

以下命令从仓库根目录执行：

```bash
# 1. 构建镜像并推送到 GHCR
pnpm build:server     # server 镜像
./scripts/build-ui.sh # UI 静态文件镜像

# 2. 部署到远端
./scripts/deploy-server.sh   # 远端 pull + restart server
./scripts/deploy-ui.sh       # 本地构建 → rsync 到远端（不重启容器）

# 健康检查
./scripts/deploy-check.sh

# 组合使用（deploy-run 仅包含部署步骤，不含构建）
./scripts/deploy-run.sh --ui --server --check
```

## 本地开发

```bash
git clone https://github.com/coclaw/coclaw.git
cd coclaw
pnpm install
cp server/.env.example server/.env
pnpm dev    # 自动启动 MySQL 容器并等待就绪，然后启动 server + ui
```
