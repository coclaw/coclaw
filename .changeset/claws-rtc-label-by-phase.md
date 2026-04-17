---
'@coclaw/ui': patch
---

claws 页面的 WebRTC 连接状态 label 重构：文案头部统一加 `WebRTC:` 前缀，中段文案与 `rtcPhase` 精确一一对应。

- 原实现把 `building / recovering / idle` 混显示为"连接中…"，把 `restarting` 与 `ready` 混显示为同一套传输详情；现按阶段分别呈现 `空闲 / 连接中 / 恢复中 / ICE 重启中 / P2P|LAN|中继 / 连接失败…` 共 6 档语义明确的文案。
- label 与 `claw.online` 解耦：依据通信模型，claw 在线与否由 server 反馈，与 WebRTC 连接状态是两条独立路径；label 现只反映 `rtcPhase` / `rtcTransportInfo`，不再受 online 门控。离线但有 RTC 历史的 claw 仍能查看 WebRTC 状态与详情。
- 新增/修改 i18n key：`rtcIdle / rtcBuilding / rtcRecovering / rtcRestarting`（新增），`rtcLan{Proto} / rtcP2P{Proto} / rtcRelay{Proto} / rtcRetrying / rtcRetryExhausted`（前缀改为 `WebRTC:`），删除不再使用的 `disconnected / rtcConnecting`。12 个语言包全部同步。
- 状态圆点颜色逻辑保持不变。
