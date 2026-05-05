# Server TODO

## SSE clawStatusStreamHandler register-after-snapshot race（2026-05-05 deep review 发现）

1. **`/api/v1/claws/status-stream` 重连窗口可能丢 `claw.bound` 推送**
    - 现状：`clawStatusStreamHandler` 顺序是 `await sendSnapshot → registerSseClient`；snapshot 期间 `sendToUser` 找不到 client 静默丢弃事件
    - 触发条件：客户端 SSE 重连的几十 ms 窗口内恰好有 `bindClawHandler` / `claimHandler` 完成绑定，并且 bind 的 DB 写入晚于 snapshot 的 DB 查询。两个条件叠加概率极低
    - 兜底：UI 端已通过"watch byId 增长（含后续 SSE 重连的 snapshot 增量）"恢复，但若用户当前重连后再没新 snapshot 触发则要等下一次 app foreground / network online
    - 修法（推荐）：`registerSseClient` 提前到 `sendSnapshot` 之前，并为新 client 加一个"snapshot 期间到达事件先入队，snapshot flush 后再 drain"的小缓冲；或在 snapshot 之后再补发一次"差异快照"
