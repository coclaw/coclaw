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

## OpenClaw Reference

Internal reference notes on OpenClaw platform concepts and behavior.

- [Key Concepts](openclaw-reference/key-concepts.md) - Channels, agents, sessions, dmScope
- [Session Format](openclaw-reference/session-format.md) - JSONL session file format specification
- [Session Key vs Session ID](openclaw-reference/session-key-vs-session-id.md) - Logical bucket vs physical transcript
- [Chat vs Agent Semantics](openclaw-reference/chat-vs-agent-semantics.md) - chat.send vs agent() method differences
- [Gateway Attachment Support](openclaw-reference/gateway-attachment-support.md) - Attachment handling analysis

## Investigations

One-off technical investigations, bug analyses, and research notes.

- [Detect SessionId Change](investigations/detect-sessionid-change.md) - Detecting sessionId rollover under agent sessionKey
- [Ensure Main Session Key Bootstrap](investigations/ensure-main-session-key-bootstrap.md) - Plugin-side session key initialization design
- [Orphan Session Resume](investigations/orphan-session-resume.md) - Orphan session continuation via Gateway agent
- [Image Silent Discard](investigations/image-silent-discard-non-vision-model.md) - Images dropped when model lacks vision support
