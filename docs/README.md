# CoClaw Documentation

## Architecture

Core design documents describing the system's structure and protocols.

- [Architecture Overview](architecture/overview.md) - Component view, API map, binding/unbind sequences, invariants
- [Bot Binding & Auth](architecture/bot-binding-and-auth.md) - Binding flow, token-based auth, data models
- [Gateway Agent RPC Protocol](architecture/gateway-agent-rpc-protocol.md) - Two-phase response protocol specification

## Decisions (ADR)

Architecture Decision Records capturing key design choices.

- [Bot Online Status](decisions/bot-online-status.md) - Bot status sensing and display approaches
- [Media Attachment Support](decisions/media-attachment-support.md) - File attachment support gap analysis
- [Plugin Consolidation](decisions/plugin-consolidation.md) - Merger of tunnel + session-manager into single plugin
- [Session Navigation](decisions/session-navigation.md) - Session navigation design options and recommendation

## Operations

Deployment, configuration, and operational guides.

- [Deploy Operations](operations/deploy-ops.md) - Internal deployment runbook
- [Deployment Plan](operations/deployment-plan.md) - Docker Compose topology, TLS/Nginx, env strategy
- [Nginx Config References](operations/nginx-conf-refs/) - Reference Nginx configurations

## OpenClaw Research

OpenClaw 平台机制研究与技术调查。

- [Channel Plugin Deep Analysis](openclaw-research/channel-plugin-deep-analysis.md) - Channel 插件机制、Session Key 命名、dmScope
- [IM Channel Interaction](openclaw-research/im-channel-interaction.md) - 队列模式、流式推送、typing、Gateway 架构
- [RPC & Session](openclaw-research/rpc-and-session.md) - Session Key/ID 概念、chat.send vs agent 协议、cron key
- [Session Format](openclaw-research/session-format.md) - JSONL transcript 格式与 content block 类型
- [Gateway Attachment Support](openclaw-research/gateway-attachment-support.md) - RPC 附件处理链路分析
- [Orphan Session Resume](openclaw-research/orphan-session-resume.md) - Orphan 续聊实现方案
- [Detect SessionId Change](openclaw-research/detect-sessionid-change.md) - SessionId 变更检测
- [Ensure Main Session Key Bootstrap](openclaw-research/ensure-main-session-key-bootstrap.md) - 主会话 key bootstrap
- [Image Silent Discard](openclaw-research/image-silent-discard-non-vision-model.md) - 非 vision 模型图片静默丢弃
