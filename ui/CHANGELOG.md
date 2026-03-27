# @coclaw/ui

## 0.9.0

### Minor Changes

- 7044e4f: feat: 机器人页面升级为 Agent Dashboard（Phase 1）

  - 新增实例总览卡片（InstanceOverview）：展示名称、在线状态、本月花费、频道状态、版本信息
  - 新增 Agent 卡片瀑布流（AgentCard）：展示身份、模型标签、能力矩阵、tokens/会话/最近活跃
  - 能力标签从 OpenClaw gateway tools.catalog 动态映射
  - 模型标签从 models.list 动态生成
  - 并行 RPC 聚合，部分失败优雅降级
  - 离线 bot 显示简化版 fallback header
  - 完善 i18n 支持（中文 + 英文）

## 0.1.1

### Patch Changes

- 0cf6cec: fix(ui,server): add WS heartbeat and improve chat disconnect resilience

  - UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
  - Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
  - ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
  - ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
  - ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure

- fix(server,ui): accumulated fixes since changeset adoption

  - server: extend binding code expiry from 5 to 30 minutes
  - server,ui: push bot name update via SSE after bridge connects
  - ui: update plugin id to openclaw-coclaw and improve AddBot page layout
  - ui: distinguish bot offline from unbound in ChatPage notification
  - ui: remove redundant bind-success notify and guard unbind double-click
  - plugin,ui: fix new-chat failure and missing session for agent:main:main
