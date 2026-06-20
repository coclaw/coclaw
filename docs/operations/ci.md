# CI 门禁

> 工作流定义：[`.github/workflows/ci.yaml`](../../.github/workflows/ci.yaml)

## 这个 CI 做什么

- **触发时机**：push 到 `main` 分支、以及任何 PR。
- **跑哪三个工作区**：`@coclaw/server`、`@coclaw/ui`、`@coclaw/openclaw-coclaw`。
- **跑什么**：装好依赖后先生成 Prisma client，再全仓跑 `pnpm check`（各工作区 lint + typecheck），最后逐个工作区跑单测（带覆盖率门禁）。
- **覆盖率门槛**固化在各工作区的测试脚本里，CI 只管跑脚本，不在 workflow 里重设：

  | 工作区 | 门槛 |
  |--------|------|
  | server | lines/functions/branches/statements 90% |
  | ui（src 档） | lines/statements 95%、branches 90% |
  | ui（electron 档） | 无覆盖率门禁（仅跑断言） |
  | plugin | lines/functions/statements 100%、branches 95% |

  ui 的 `test` 串跑 `test:src`（带覆盖率）+ `test:electron`（不带覆盖率）两档。

## MySQL 怎么来的

server 单测真连 MySQL。CI 用一个一次性 MySQL 容器满足，**mysqld 配置严格对齐生产**（原因见下一节）：

- 用 `docker run` 手动起 `mysql:8.0.36`，带齐与生产 / dev compose（`deploy/compose.yaml`、`deploy/compose.dev.yaml`）一致的设置：
  - `--lower_case_table_names=1` — 表名大小写不敏感
  - `--collation-server=utf8mb4_unicode_ci`、`--character-set-server=utf8mb4` — 排序规则 / 字符集
  - `--default-time-zone=+08:00` — 时区
- 容器起好（一段就绪等待确认能以 app 用户连上）后，跑 `prisma:migrate:deploy`（`prisma migrate deploy`）建表，再跑 server 单测。
- 账密（`coclaw` / `coclaw_db_2026` 等）是**非密钥的一次性测试值**，与 dev 一致，明文写在 workflow 里是有意为之，**不是泄密**——容器随 job 销毁，不接触任何生产凭据。

### 为什么对齐这些设置、为什么不用 `services:` 块

CI 的 MySQL 必须忠实复刻生产的数据库契约，否则 CI 与生产两头不一致、误报漏报都可能。dev 与生产 compose 都给 MySQL 钉了一组**非默认**设置，CI 不能用原版 `mysql:8.0.36`（吃默认值）糊弄：

- **`lower_case_table_names`**：生产钉 `1`（大小写不敏感），而 Linux 上 MySQL 默认 `0`（敏感）。早期迁移把表建成 `Device`、后续迁移又引用小写 `device`——在默认敏感的库上从空库 clean 重放会直接报「表不存在」。这正是 CI 首跑暴露、而 dev / 生产因钉了 `=1` 一直没事的预存问题。**此项只能在数据目录首次初始化时定、事后改不了**，所以必须容器一起来就带上。
- **`collation-server`**：生产钉 `utf8mb4_unicode_ci`，而 MySQL 8.0 默认是 `utf8mb4_0900_ai_ci`——两者排序、以及「哪些字符串算相等」（唯一约束碰撞）的语义不同。不对齐会让大小写 / 重音相关的行为在 CI 与生产表现不一致。

GitHub Actions 的 `services:` 容器只能传 docker 层参数、传不进 mysqld 的命令行 flag，所以改用手动 `docker run mysql:8.0.36 <flags>` + 就绪等待——与 dev / 生产 compose 用的是同一个机制。

## 为什么单列 Prisma generate

Prisma client 是 gitignored 的派生产物，全新检出（CI）时不存在。workflow 在装依赖后、`pnpm check` 之前单列一步 `prisma:generate` 生成它。

server 的 `test` 脚本本身开头也会先 `prisma generate`，所以单看当前流程这步**看似冗余**——但它是**有意保留的保险，别图省事删掉**：

- 历史上全新检出缺 client 曾导致一批 import-time「找不到模块」报错（git 历史可查：当初正是为修这个，才把 `prisma generate` 焊进 dev/test 脚本）。
- 现在 `pnpm check` 不解析 import（eslint 只有 `semi`/`indent`/`no-unused-vars` 三条规则），所以 check 确实不依赖 client；但将来一旦给 check 引入真正的 import / 类型解析，「靠 server test 顺带生成」这个隐式时序假设就会悄悄失效、首跑误红。单列这步把流程和该假设解耦。
- 代价几乎为零：`prisma generate` 约 0.7s、幂等、只读 schema 不连库。

## 本地怎么复现 CI

- 全仓静态检查：`pnpm check`。
- 各工作区单测：`pnpm --filter <pkg> test`。
- server 单测需先备好 MySQL：起本地 dev MySQL → `pnpm --filter @coclaw/server prisma:migrate:deploy` → `export DB_URL=...` 后再跑 test（`node --test` 不读 `.env`）。细节见 [`local-dev-setup.md`](local-dev-setup.md) 与 `server/CLAUDE.md` 的「跑单测前置」。

## 明确不在 CI 范围内的东西

以下都**有意**排除在阻塞门禁之外，各有原因：

1. **E2E 进 CI** — E2E 的 global-setup 会把本机真实 OpenClaw 网关抢去绑到测试服，且 `@chat` / `@rtc` / `@file` 类用例需要一个真实在线的 claw 端、否则 skip；还强制带界面跑。近期一串提交都在修它的偶发失败，放进阻塞门禁会反复误红。**E2E 继续本地手动跑**（见 `e2e-test` skill）。
2. **CD（构建推镜像 + 部署生产）** — 单台生产机，现用 `scripts/deploy-*.sh` + SSH 手动部署。自动化真部署要往 CI 塞生产 SSH / 镜像仓库密钥，维护期单人场景成本大于收益。**继续手动部署**（见 [`deploy-ops.md`](deploy-ops.md)）。
3. **发版自动化（Changesets workflow）** — **继续手动跑 `/release`**。
4. **桌面 / 移动原生打包（Electron / Capacitor / iOS / macOS）** — 需 macOS / Windows runner + 签名证书，Linux CI 跑不了。**范围外**。

将来真有多人协作 / 高频发布需求时，再补 CD 与发版自动化。
