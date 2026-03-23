---
'@coclaw/ui': minor
---

feat: 机器人页面升级为 Agent Dashboard（Phase 1）

- 新增实例总览卡片（InstanceOverview）：展示名称、在线状态、本月花费、频道状态、版本信息
- 新增 Agent 卡片瀑布流（AgentCard）：展示身份、模型标签、能力矩阵、tokens/会话/最近活跃
- 能力标签从 OpenClaw gateway tools.catalog 动态映射
- 模型标签从 models.list 动态生成
- 并行 RPC 聚合，部分失败优雅降级
- 离线 bot 显示简化版 fallback header
- 完善 i18n 支持（中文 + 英文）
