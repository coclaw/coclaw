# Server TODO

## SSE clawStatusStreamHandler register-after-snapshot race（2026-05-05 deep review 发现）

1. **`/api/v1/claws/status-stream` 重连窗口可能丢 `claw.bound` 推送**
    - 现状：`clawStatusStreamHandler` 顺序是 `await sendSnapshot → registerSseClient`；snapshot 期间 `sendToUser` 找不到 client 静默丢弃事件
    - 触发条件：客户端 SSE 重连的几十 ms 窗口内恰好有 `bindClawHandler` / `claimHandler` 完成绑定，并且 bind 的 DB 写入晚于 snapshot 的 DB 查询。两个条件叠加概率极低
    - 兜底：UI 端已通过"watch byId 增长（含后续 SSE 重连的 snapshot 增量）"恢复，但若用户当前重连后再没新 snapshot 触发则要等下一次 app foreground / network online
    - 修法（推荐）：`registerSseClient` 提前到 `sendSnapshot` 之前，并为新 client 加一个"snapshot 期间到达事件先入队，snapshot flush 后再 drain"的小缓冲；或在 snapshot 之后再补发一次"差异快照"

## Web Agent — review 中发现的预存问题（2026-05-10 deep review 发现）

1. **`docs/designs/web-agents.md` 第六章 `recordClick` 示例签名漂移（预存）**
    - 现状：示例代码用旧签名 `recordClick(userId, webAgentId)`，但实际实现已是 `recordClick({ userId, webAgentId }, deps = {})`；同章新加的 `hide` 示例已用新签名，新旧并存读起来困惑
    - 修法：把 click 的代码示例改成对象签名 + 可选 deps，与 `hide` 保持一致

2. **`docs/designs/web-agents.md` 第十一章 click 测试要点错位（预存）**
    - 现状："POST `/click` 首次 → create 记录、clickCount=1" 与 "POST `/click` 重复 → increment 计数 + 刷新 lastClickedAt" 列在 route 测试要点下，但这两条实际是 repo 层 `incrementClick` 的测试（`web-agent.repo.test.js`）
    - 修法：移到 repo 测试要点；如有需要，在 route 要点下补"401/400/404/204 + service throw → next(err)"等真实存在的 route 测试

3. **passport 反序列化 invariant 假设：所有 route handler 仅 truthy 检查 `req.user`，未校验 `req.user.id` 非空**
    - 现状：`requireSession` 仅 `req.isAuthenticated() && req.user`；若 user 对象存在但 id 为 undefined，`updateMany where: { userId: undefined }` 会被 prisma 视为"不过滤"，理论上扩散更新所有用户
    - 实际触发条件：passport `deserializeUser` 失败但仍返回非 null user 对象——生产上 `user.repo.findById` 返回 null 时 deserializeUser 直接返 null，user 对象不会缺 id；但 invariant 应显式收紧
    - 修法：`requireSession` 加 `req.user.id != null` 检查（全 server 路由共享）

4. **`hide` updateMany 同毫秒重复调用的 affected count 行为依赖 mysql2 / prisma 的 CLIENT_FOUND_ROWS 设置**
    - 现状：单元测试用不同 timestamp 验证幂等；同毫秒重复 hide 在某些 driver 配置下可能返 changed_rows=0 → svc false → route 404
    - 实际触发：UI 上 hide 后该 item 立即从 recently 列表消失，二次 hide 在前端不可达——产品场景不会触发
    - 修法（如真要硬化）：repo 层显式 `findFirst` → `update` 替代 `updateMany`，把"已存在 click 行"判定从 affected count 改为 select；或用对 `now` 加几毫秒防同时间冲突
