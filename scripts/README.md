# Deploy Scripts (Internal)

这些脚本用于 CoClaw 内部部署（当前目标域名：`im.coclaw.net`）。

## 脚本一览

- `deploy-common.sh`：公共函数与默认环境变量
- `deploy-ui.sh`：前端发布（build + release + 切换软链 + nginx重启）
- `deploy-server.sh`：后端发布（同步代码 + 构建 server + 重启 server）
- `deploy-db.sh`：数据库迁移（可选 `--db-push` / `--create-test-account`）
- `deploy-check.sh`：部署后健康检查
- `deploy-run.sh`：组合执行入口
- `deploy-clean.sh`：清理远端 Docker 未使用资源（镜像、构建缓存等）

## 常用命令

```bash
# 仅前端改动
./scripts/deploy-run.sh --ui --check

# 后端改动（含迁移）
./scripts/deploy-run.sh --server --db --check

# 全量内部发布
./scripts/deploy-run.sh --ui --server --db --check
```

## 可覆盖环境变量

- `DEPLOY_HOST`（默认 `coclaw.net`）
- `DEPLOY_REMOTE_DIR`（默认 `~/coclaw`）
- `DEPLOY_DOMAIN`（默认 `im.coclaw.net`）

示例：

```bash
DEPLOY_HOST=coclaw.net DEPLOY_DOMAIN=im.coclaw.net ./scripts/deploy-check.sh
```

更多说明见：`docs/deploy-ops.md`
