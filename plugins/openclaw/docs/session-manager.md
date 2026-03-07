# Session Manager（@coclaw/openclaw-coclaw 子模块，plugin id: coclaw）

提供最小会话管理网关方法（位于 `src/session-manager/`）：
- `nativeui.sessions.listAll`
- `nativeui.sessions.get`

`nativeui.sessions.listAll` 当前行为：
- 扫描 live transcript：`<sessionId>.jsonl`
- 扫描 reset 归档 transcript：`<sessionId>.jsonl.reset.<timestamp>`
- 排除 deleted 归档 transcript：`<sessionId>.jsonl.deleted.<timestamp>`（兼容排除 `.jsonl.delete.<timestamp>`）
- 按 `sessionId` 去重：同 id 存在多文件时仅返回一条，优先 `reset`，其次 `live`
- 返回项按需增加 `derivedTitle`：
  - 若 transcript 中存在第一条包含 text 的 user message，则返回其截断标题
  - 若找不到 user text，则该 session **不返回** `derivedTitle`（由前端回退显示）

`nativeui.sessions.get` 当前行为：
- 读取同 id transcript 时优先 `reset`（取最新 mtime 的 reset 文件）
- 若无 reset，则回退读取 live：`<sessionId>.jsonl`

> 本阶段不提供 delete。

## 测试

```bash
pnpm test
pnpm coverage
pnpm verify
```
