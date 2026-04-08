# CoClaw 文档

## 阅读指南

**快速了解系统**：从 [架构总览](architecture/overview.md) 开始，然后阅读 [通信模型](architecture/communication-model.md)。

**深入具体设计**：Architecture 目录描述"系统现在是什么样"，Designs 目录记录"某个功能是怎么设计的"（含历史过程）。

---

## Architecture — 系统架构（当前真相）

描述系统的稳定架构，持续更新以反映现状。

- [架构总览](architecture/overview.md) — 组件视图、通道一览、分层、绑定/认领流程、核心不变式
- [通信模型](architecture/communication-model.md) — 三层通道（含 server-relayed RPC）、两层超时、连接生命周期、ClawConnection 抽象
- [绑定与认证](architecture/bot-binding-and-auth.md) — Binding + Claim 双流程、token 认证、数据模型
- [Agent RPC 协议](architecture/gateway-agent-rpc-protocol.md) — 两阶段响应协议规范
- [多 Agent 支持](architecture/multi-agent-support.md) — Claw/Agent 层级、身份解析链、数据流

## Decisions — 架构决策记录 (ADR)

关键设计选择的决策记录，一旦决定较少变动。

- [移动端/桌面端框架选型](decisions/adr-mobile-desktop-framework.md) — Capacitor(mobile) + Electron(desktop)
- [Bot 在线状态](decisions/bot-online-status.md) — 状态感知与展示方案
- [媒体附件支持](decisions/media-attachment-support.md) — 非图片附件差距分析
- [孤儿 Bot 防护](decisions/orphan-bot-prevention.md) — 防止绑定记录泄漏
- [插件合并](decisions/plugin-consolidation.md) — tunnel + session-manager 合并为单插件
- [Session 导航](decisions/session-navigation.md) — sessionKey vs sessionId 导航模型
- [Topic 限制 main agent](decisions/topic-main-agent-constraint.md) — Topic 仅限 main agent 的原因
- [WebSocket 心跳](decisions/websocket-heartbeat.md) — 各链路心跳机制分析与方案选择

## Designs — 功能设计稿（过程文档）

各功能的设计方案。每篇头部标注状态（`已实施` / `草案` / `待实施`），已实施的设计可能与当前代码有细微偏差——以代码为准。

- [WebRTC P2P 数据通道](designs/webrtc-p2p-channel.md) — P2P DataChannel 设计（Phase 1-3 已实施，部分内容已过时）
- [RTC 信令通道](designs/rtc-signaling-channel.md) — per-tab 信令 WS 重构（已实施）
- [文件管理](designs/file-management.md) — WebRTC DC 文件操作协议（已实施）
- [多模态附件](designs/multimodal-attachments.md) — 附件上传与嵌入（已实施）
- [远程日志通道](designs/remote-log-channel.md) — 诊断日志推送（已实施，含基础埋点）
- [斜杠命令](designs/slash-command-support.md) — 斜杠命令路由（已实施）
- [Chat 历史追踪](designs/chat-history-tracking.md) — 历史 session 追踪（已实施，Phase 3 清理待做）
- [Topic 管理](designs/topic-management.md) — 独立 Topic 功能（已实施）
- [认领绑定](designs/claim-bind.md) — OpenClaw 侧发起绑定（已实施）
- [TURN over TLS](designs/turn-over-tls.md) — 端口 443 穿透方案（已实施）
- [DC 文件传输排查](designs/dc-file-transfer-issues.md) — DataChannel 大文件传输故障分析（部分实施）
- [Electron 桌面壳](designs/electron-desktop-shell.md) — 桌面端方案（草案）
- [Tauri 桌面壳](designs/tauri-desktop-shell.md) — Tauri 方案（已放弃，保留备用）
- [API 迁移 bot→claw](designs/api-bot-to-claw-migration.md) — bot→claw 命名迁移（全部完成）
- [OpenClaw 实例身份](designs/openclaw-instance-identity.md) — 跨重绑持久身份（研究阶段）

## OpenClaw Research — 上游研究

OpenClaw 平台机制研究，用于指导 CoClaw 集成。

- [核心架构](openclaw-research/core-architecture.md) — 三层模型、Channel、Session 机制
- [Gateway 协议](openclaw-research/gateway-protocols.md) — RPC 协议、队列/流式、Transcript
- [Agent 事件流](openclaw-research/agent-event-streams-and-rpcs.md) — Agent 流式事件类型
- [Agent 身份 API](openclaw-research/agent-identity-api.md) — Agent 名称/头像数据源
- [文件传输机制](openclaw-research/file-transfer-mechanisms.md) — OpenClaw 原生文件传输
- [集成要点](openclaw-research/integration-notes.md) — 已知限制与集成经验
- [Topic 调研](openclaw-research/topic-feature-research.md) — Topic 功能 OpenClaw 侧机制
- [运行时与运维](openclaw-research/runtime-and-operations.md) — Agent 生命周期、并发、幂等
- [PM 入门](openclaw-research/openclaw-for-pm.md) — 面向产品经理的概念说明

## Product — 产品文档

- [战略分析](product/coclaw-strategic-analysis.md) — CoClaw 作为 bot-native 平台的定位
- [vs IM 优势](product/coclaw-vs-im-advantages.md) — 相对 IM 渠道的结构性优势
- [多 Agent PRD](product/multi-agent-support-prd.md) — 多 Agent 产品需求
- [Agent 面板](product/agent-panel-design.md) — Agent 面板数据可行性
- [认领绑定用户流](product/claim-bind-user-flow.md) — 认领绑定用户侧流程
- [Topic 限制说明](product/topic-main-agent-only.md) — 面向 PM 的 Topic 限制解释
- [V1.0 功能追踪](product/v1.0-feature-tracker.md) — V1.0 功能实现状态

## Operations — 运维

- [部署操作](operations/deploy-ops.md) — 内部部署手册
- [WSL2 网络配置](operations/wsl2-network-setup.md) — WSL2 防火墙配置（WebRTC UDP）

## Study — 技术调研

- [混合应用状态恢复](study/hybrid-app-state-recovery.md) — Web+Native shell 状态恢复模式
- [WebRTC 连接研究](study/webrtc-connection-research.md) — ICE restart、WRTC 库选型
- [WebRTC 概览](study/webrtc-overview.md) — WebRTC 技术入门

## Other

- [版本管理](versioning.md) — Changesets + Independent 版本策略
- [OpenClaw 上游 Issues](openclaw-upstream-issues.md) — 已提交的上游 bug 追踪
