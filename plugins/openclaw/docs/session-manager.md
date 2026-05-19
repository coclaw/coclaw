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
- 返回项包含 `sessionId`、`sessionKey`、`indexed`、`archiveType`、`fileName`、`size`、`updatedAt`
- 支持 cursor 分页（`cursor`、`nextCursor`、`total`）
- 不读取 transcript 内容（只走 readdir + stat 元数据），UI 标题由 chat-history / topic 的 title 字段提供

> 注：`listAll` 隐藏 `.deleted.*` 归档；UI 拿到的"历史 session id"实际走 `coclaw.chatHistory.list`，而后用 `coclaw.sessions.getById` 读取——`.deleted.*` 归档对应的 sessionId 即来自这条路径。

## `nativeui.sessions.get`

- 读取同 id transcript 时**优先 `live` 文件**（live 代表当前活跃 transcript）
- 若无 live，回退扫归档：合并 `<sessionId>.jsonl.reset.<timestamp>` 与 `<sessionId>.jsonl.deleted.<timestamp>`，按时间戳字典序倒序取最新（OpenClaw 严格 ISO `YYYY-MM-DDTHH-MM-SS.sssZ` 格式，字典序 = 时间序）
- 归档候选过 ISO 格式 regex 校验，**忽略 `.jsonl.reset.<ts>.bak` 等 trailing-garbage 文件**（rsync / 手工备份残留）
- 支持 cursor 分页（按 JSONL 行偏移）

## `coclaw.sessions.getById`

- 输入 `sessionId`（必填）和 `limit`（可选）
- 仅返回 `type === "message"` 的行，过滤掉元数据行
- transcript 文件查找规则同 `nativeui.sessions.get`（两者共享 `resolveTranscriptFile`，所以同样支持 `.deleted.*` 归档 fallback 与 trailing-garbage 过滤）
- `limit` 语义：
  - 不传 / `null` / 非 number 类型（string、boolean、array、object）/ `NaN` / `Infinity` / `< 1` → 返回全部
  - `>= 1` 的有限数 → 取最后 `Math.trunc(limit)` 条（如 `2.9 → 2`）
  - **无默认值、无上限**——避免历史的"静默截断到 500 条"问题

## 测试

```bash
pnpm check
pnpm test
```
