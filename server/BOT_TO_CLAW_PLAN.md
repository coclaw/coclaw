# Bot → Claw 重命名：Server 后续阶段计划

> 临时文档，用于上下文压缩后恢复工作状态。完成后删除。

## 已完成

### Phase 1 + DB Phase 2 合并

1. **DB 物理表名**：`bot` → `Claw`，`botbindingcode` → `ClawBindingCode`
2. **索引/FK**：全部从 `Bot_*` → `Claw_*`（含 FK `Claw_userId_fkey`）
3. **Migration**：`20260404000000_rename_bot_tables_to_claw`（原子 RENAME + INDEX RENAME + FK DROP/ADD）
4. **Prisma schema**：model `Bot` → `Claw`，`BotBindingCode` → `ClawBindingCode`，User 关系 `bots` → `claws`，无 `@@map`
5. **Repo 层**：`bot.repo.js` → `claw.repo.js`，`bot-binding-code.repo.js` → `claw-binding-code.repo.js`
6. **生产部署**：server v0.8.0 已部署到 im.coclaw.net

### Server 内部代码重命名（commit: dac966e）

7-11. 文件重命名、导出标识符、内部变量/Map、RESERVED_NAMES 等（详见上一版文档）

### Server API 兼容层（完成）

12. **HTTP 响应字段双写**（commit: 527e336）：所有含 `botId`/`bot` 的响应新增 `clawId`/`claw`

13. **SSE 双事件**：每个推送先发 `claw.*`（新版 UI），再发 `bot.*`（旧版 UI）
    - `claw.snapshot` / `bot.snapshot`
    - `claw.status` / `bot.status`
    - `claw.nameUpdated` / `bot.nameUpdated`
    - `claw.bound` / `bot.bound`
    - `claw.unbound` / `bot.unbound`

14. **HTTP 路由别名**：`/api/v1/claws/*` 与 `/api/v1/bots/*` 指向同一 handler

15. **WS 路径别名**：`/api/v1/claws/stream` 与 `/api/v1/bots/stream` 均接受 WS 连接

16. **验证**：`pnpm check` ✅，686 tests pass ✅

## 后续计划

### 生产部署

- 部署新版 server，验证旧版 plugin/UI 兼容性
- 纯增量（新字段、新事件、新路由），无 DB migration，部署风险低

### Plugin 迁移（已完成）

- 已切换到读 `clawId`/`claw`，文件/函数/变量全部重命名
- 详见 `docs/designs/api-bot-to-claw-migration.md` Phase C

### UI 迁移

- 切换到 `claw.*` SSE 事件和 `/api/v1/claws/*` 路径
- 详见 `docs/designs/api-bot-to-claw-migration.md` Phase D

### WS 信令 botId（三端联动，server 侧已完成）

- server 已支持 `payload.clawId || payload.botId` 兼容
- server 已支持 `?clawId=` 和 `?botId=` 查询参数
- 路由表内部字段已从 `botId` 改为 `clawId`
- UI 侧待迁移：出站消息 `botId` → `clawId`，连接参数 `?botId=` → `?clawId=`

### WS 消息类型 + close reason（server 侧已完成）

- `notifyAndDisconnectClaw`：先发 `claw.unbound` 再发 `bot.unbound`
- `onClawMessage`：同时接受 `claw.unbound` 和 `bot.unbound`
- `getWebSocketCloseCode`：同时接受 `claw_unbound`/`bot_unbound` 和 `claw_blocked`/`bot_blocked`
- 详见 `docs/designs/api-bot-to-claw-migration.md`

### 注意事项

- `genTurnCreds` 已被用户改为 `genTurnCredsForGateway`（claw-ws-hub.js 和 rtc-signal-hub.js 中）
- `RESERVED_NAMES` 中的 `'bot'` 应继续保留
- claim/enroll 端点已是 `/api/v1/claws/...` 路径，无需路由别名
