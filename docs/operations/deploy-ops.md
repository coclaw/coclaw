# Internal Deploy Ops

> 本文档已合并到 [`deploy/README.md`](../../deploy/README.md) 的"开发者部署"部分。
> 以下保留磁盘维护和应急操作的补充说明。

## 前置约定

- 默认远端主机：`im.coclaw.net`（可通过 `DEPLOY_HOST` 覆盖）
- 默认远端目录：`~/coclaw`（可通过 `DEPLOY_REMOTE_DIR` 覆盖）
- 默认域名：`im.coclaw.net`（可通过 `DEPLOY_DOMAIN` 覆盖）
- 若本地存在 `~/.ssh/agent.sock`，脚本会自动使用

## 脚本说明

位于 `scripts/`：

| 脚本 | 功能 |
|------|------|
| `build-server.sh` | 构建多架构 server 镜像并推送到 GHCR（`pnpm build:server`） |
| `build-ui.sh` | 构建 UI 并推送镜像到 GHCR（供自部署用户使用） |
| `deploy-server.sh` | server 部署（远端 pull + restart） |
| `deploy-ui.sh` | UI 发布（本地 build → rsync → 符号链接切换，无需重启容器） |
| `deploy-db.sh` | 数据库手动操作（`--db-push`、`--create-test-account`） |
| `deploy-check.sh` | 部署后健康检查 |
| `deploy-clean.sh` | 远端 Docker 资源清理 |
| `deploy-run.sh` | 组合执行入口 |

> 注：Prisma migration 已由 server 容器 entrypoint 自动执行，`deploy-db.sh` 仅用于手动操作。

## 常用命令

```bash
# UI 发布
./scripts/deploy-ui.sh

# Server 发布
./scripts/deploy-server.sh

# 组合执行
./scripts/deploy-run.sh --ui --server --check

# DB 应急模式（仅内部）
./scripts/deploy-db.sh --db-push --create-test-account
```

## 磁盘维护

### Docker 清理

```bash
./scripts/deploy-clean.sh              # 清理 7 天前的未使用资源
./scripts/deploy-clean.sh --all        # 清理全部未使用资源
./scripts/deploy-clean.sh --dry-run    # 仅查看，不清理
./scripts/deploy-clean.sh --keep=72h   # 自定义保留时长
```

建议在每次 `deploy-server.sh` 后执行清理，或定期运行。

## 故障排查

```bash
# 检查服务状态
./scripts/deploy-check.sh

# 远端查看日志
ssh im.coclaw.net "cd ~/coclaw && docker compose logs --tail=200 server nginx"

# 远端查看所有服务
ssh im.coclaw.net "cd ~/coclaw && docker compose --profile auto-https ps"
```

## 说明与边界

- `--db-push` 仅用于内部环境快速修复 schema 漂移，不建议作为常规流程
- 证书续期由 `certbot-renew` 容器自动处理（`--profile auto-https` 启动时包含）
