# Server TODO

## SSE clawStatusStreamHandler register-after-snapshot race（2026-05-05 deep review 发现）

1. **`/api/v1/claws/status-stream` 重连窗口可能丢 `claw.bound` 推送**
    - 现状：`clawStatusStreamHandler` 顺序是 `await sendSnapshot → registerSseClient`；snapshot 期间 `sendToUser` 找不到 client 静默丢弃事件
    - 触发条件：客户端 SSE 重连的几十 ms 窗口内恰好有 `bindClawHandler` / `claimHandler` 完成绑定，并且 bind 的 DB 写入晚于 snapshot 的 DB 查询。两个条件叠加概率极低
    - 兜底：UI 端已通过"watch byId 增长（含后续 SSE 重连的 snapshot 增量）"恢复，但若用户当前重连后再没新 snapshot 触发则要等下一次 app foreground / network online
    - 修法（推荐）：`registerSseClient` 提前到 `sendSnapshot` 之前，并为新 client 加一个"snapshot 期间到达事件先入队，snapshot flush 后再 drain"的小缓冲；或在 snapshot 之后再补发一次"差异快照"

## Web Agent — review 中发现的预存问题（2026-05-10 deep review 发现）

1. **`hide` updateMany 同毫秒重复调用的 affected count 行为依赖 mysql2 / prisma 的 CLIENT_FOUND_ROWS 设置**
    - 现状：单元测试用不同 timestamp 验证幂等；同毫秒重复 hide 在某些 driver 配置下可能返 changed_rows=0 → svc false → route 404
    - 实际触发：UI 上 hide 后该 item 立即从 recently 列表消失，二次 hide 在前端不可达——产品场景不会触发
    - 修法（如真要硬化）：repo 层显式 `findFirst` → `update` 替代 `updateMany`，把"已存在 click 行"判定从 affected count 改为 select；或用对 `now` 加几毫秒防同时间冲突
