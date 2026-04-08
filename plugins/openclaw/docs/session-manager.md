# Session Manager（@coclaw/openclaw-coclaw 子模块，plugin id: openclaw-coclaw）

提供会话管理网关方法（位于 `src/session-manager/`）：
- `nativeui.sessions.listAll` — 列出所有 session（分页）
- `nativeui.sessions.get` — 获取 session 原始 JSONL 行（分页）
- `coclaw.sessions.getById` — 按 sessionId 获取消息记录（仅 `type==="message"` 行）

## `nativeui.sessions.listAll`

- 扫描 live transcript：`<sessionId>.jsonl`
- 扫描 reset 归档 transcript：`<sessionId>.jsonl.reset.<timestamp>`
- 排除 deleted 归档 transcript：`<sessionId>.jsonl.deleted.<timestamp>`（兼容排除 `.jsonl.delete.<timestamp>`）
- 按 `sessionId` 去重：同 id 存在多文件时仅返回一条，**优先 `live`，其次 `reset`**（`live` 代表当前活跃 transcript）
- 合并 `sessions.json` 中已索引但无 transcript 文件的 session（`indexed: true`，无 `size`/`updatedAt`）
- 返回项包含 `sessionId`、`sessionKey`、`indexed`、`size`、`updatedAt`、`derivedTitle`
- 支持 cursor 分页（`cursor`、`nextCursor`、`total`）
- `derivedTitle` 推导规则：
  - 取 transcript 中第一条包含 text 的 user message，截断作为标题
  - 自动清除 OC 注入的元数据前缀（时间戳、`[cron:...]`、inbound meta 块等）
  - 若找不到 user text，则不返回 `derivedTitle`（由前端回退显示）

## `nativeui.sessions.get`

- 读取同 id transcript 时**优先 `live` 文件**（live 代表当前活跃 transcript，同一 sessionId 可能同时存在 live 和 reset 文件）
- 若无 live，则回退读取 reset 文件（取最新 mtime 的 reset 文件）
- 支持 cursor 分页（按 JSONL 行偏移）

## `coclaw.sessions.getById`

- 输入 `sessionId`（必填）和 `limit`（可选，默认 500）
- 仅返回 `type === "message"` 的行，过滤掉元数据行
- transcript 文件查找规则同 `nativeui.sessions.get`

## 测试

```bash
pnpm check
pnpm test
```
