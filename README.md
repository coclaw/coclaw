[English](README.md) | [简体中文](README.zh-CN.md)

# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

> **The world's first native [OpenClaw](https://github.com/openclaw/openclaw) IM application.**

Slogan: Manage your AI Agents with CoClaw.CoClaw 

Mission: To provide an uncompromised, fully native, AI‑optimized flagship communication platform for collaboration between multiple humans and multiple Agents.

What is CoClaw: CoClaw is the world’s first flagship communication platform built natively for AI Agents. It inherits the design philosophy of OpenClaw and serves as the most essential native carrier for OpenClaw.

CoClaw Belief: An AI Agent is more than a chatbot; it is an AI assistant with identity, memory, capabilities, autonomy, and collaboration needs. CoClaw systematically supports 49 types of collaboration between humans and Agents, and between Agents. It provides transparent workflows, real-time intervention, team scheduling, memory growth, and fine-grained authorization, enabling users to have an observable, controllable, trainable, collaborative, and growing AI assistant team.

CoClaw Vs Human IM: CoClaw is natively designed for AI Agents, centered on collaboration, making AI Agents governable, team-capable, and autonomously growing; human IM is chat-centric, treating Agents as ordinary group members with full black-box and uncontrollable behavior.

## Repository Structure

This is a **pnpm monorepo**:

| Workspace | Description |
|-----------|-------------|
| `server` | Backend service (Express + Prisma + MySQL) |
| `ui` | Frontend application (Vue 3 + Nuxt UI 4 + Tailwind) |
| `admin` | Admin panel (reserved, not in active development) |
| `plugins/openclaw` | OpenClaw plugin — binding, realtime bridge, session management |

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm
- MySQL

### Install & Run

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts both `server` and `ui` in parallel. Press `Ctrl+C` to stop.

To run individually: `pnpm dev:server` or `pnpm dev:ui`.

> The UI dev server (port 5173) proxies `/api` and WebSocket requests to the server (port 3000) via Vite, so no extra production config is needed locally.

### Quality Gates

```bash
pnpm check      # Lint + type check
pnpm test       # Unit tests
pnpm coverage   # Coverage check (lines/functions/statements >= 70%, branches >= 60%)
pnpm verify     # check -> test -> coverage (all-in-one)
```

### Developer Workflow

```bash
pnpm install
# Make changes + update tests/docs
pnpm verify
git commit -m "feat(scope): short summary"
```

## Documentation

See [docs/](docs/README.md) for architecture, decision records, operations guides, and more.

## License

- `coclaw` (root), `ui`, `server`, `admin`: **CoClaw modified Apache-2.0** (see `LICENSE`).
- `plugins/openclaw`: Standard **Apache-2.0** (see `plugins/openclaw/LICENSE`).
- Copyright © 2026 Chengdu Gongyan Technology Co., Ltd.
