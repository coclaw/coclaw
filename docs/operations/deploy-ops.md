# Internal Deploy Ops (CoClaw)

> 当前仅用于内部环境（`im.coclaw.net`）。
> 非完整“一键部署”，而是可复用的半自动脚本。

## 前置约定

- 默认远端主机：`coclaw.net`
- 默认远端目录：`~/coclaw`
- 默认域名：`im.coclaw.net`
- 若本地存在 `~/.ssh/agent.sock`，脚本会自动使用

可通过环境变量覆盖：

- `DEPLOY_HOST`
- `DEPLOY_REMOTE_DIR`
- `DEPLOY_DOMAIN`

---

## 脚本说明

位于 `scripts/`：

- `deploy-ui.sh`：前端发布（build + release + 软链切换 + nginx重启）
- `deploy-server.sh`：后端发布（sync + build server + up server）
- `deploy-db.sh`：数据库迁移与可选初始化
- `deploy-check.sh`：部署后健康检查
- `deploy-run.sh`：组合执行入口

---

## 常用命令

### 仅前端改动后发布

```bash
./scripts/deploy-ui.sh
./scripts/deploy-check.sh
```

### 后端改动后发布

```bash
./scripts/deploy-server.sh
./scripts/deploy-db.sh
./scripts/deploy-check.sh
```

### 组合执行（推荐）

```bash
./scripts/deploy-run.sh --ui --check
./scripts/deploy-run.sh --server --db --check
./scripts/deploy-run.sh --ui --server --db --check
```

### DB 应急模式（仅内部）

```bash
./scripts/deploy-db.sh --db-push --create-test-account
```

---

## Env 文件保护

`deploy-common.sh` 中的 `sync_repo` 使用 `rsync --delete` 同步本地仓库到远端。
为防止同步时误删远端手动维护的 env 文件，rsync 已配置以下排除规则：

```
--exclude 'deploy/.env'
--exclude 'deploy/env/*.env'
```

因此远端的 `deploy/.env`、`deploy/env/server.env`、`deploy/env/mysql.env`、`deploy/env/certbot.env` 不会被 rsync 覆盖或删除。

### 首次部署：远端 env 初始化（一次性操作）

首次部署到新环境时，需在远端手动从模板创建 env 文件并填入实际凭据：

```bash
cd ~/coclaw/deploy
cp .env.example .env
cp env/server.env.example env/server.env
cp env/mysql.env.example env/mysql.env
cp env/certbot.env.example env/certbot.env
# 编辑各文件填入实际值（密码、密钥等）
```

> 注意：若 MySQL 数据卷需要重建（如凭据变更），需先停止容器并删除旧 volume，再用新 env 重新初始化。

---

## 说明与边界

- `--db-push` 仅用于内部环境快速修复 schema 漂移，不建议作为常规流程。
- 证书流程当前仍按已有 deploy 文档手动处理（ICP 前后域名策略会变化）。
- 若部署失败，优先执行：
  - `./scripts/deploy-check.sh`
  - 远端 `docker compose logs --tail=200 server nginx`
