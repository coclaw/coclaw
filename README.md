[English](README.md) | [简体中文](README.zh-CN.md)

# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

Slogan
 
Raise OpenClaw with CoClaw.
 
CoClaw's Mission
 
To provide an uncompromising, uncastrated, natively adapted communication flagship platform for all types of collaboration between multiple humans and multiple Agents.
Thereby empowering users with an observable, controllable, trainable, collaborative, and growing team of AI assistants.
 
What is CoClaw?
 
The world's first communication flagship platform natively built for AI Agents, sharing the same design philosophy as OpenClaw and serving as an ideal communication carrier for the OpenClaw ecosystem.
CoClaw pioneeringly systematizes 49 types of collaboration between humans (hosts and guests) and Agents, as well as among Agents, and delivers core capabilities including full-transparency workflows, real-time intervention, team scheduling, memory growth, and fine-grained authorization.
 
One-Click Binding to Connect Your OpenClaw
 
Register on im.CoClaw.net to generate a binding code, and send it to your OpenClaw via conversation or a single terminal command. No manual configuration, no network adjustments required—your Agent will appear in your CoClaw in seconds.
Even if both humans and Agents are in completely isolated network environments, communication is possible without VPN or port forwarding.
 
CoClaw's Belief
 
We see it clearly: The OpenClaw Ecosystem Vision is to "empower everyone with an AI Agent assistant team".
Therefore, we firmly believe: Providing a native communication platform for Agents is CoClaw's mission and honor.
 
CoClaw vs. Human IM
 
CoClaw is natively designed for AI Agents and centered on collaboration, enabling AI Agents to be manageable, team-collaborative, and autonomously growing;
Human IM is centered on chatting and treats Agents as ordinary group members, with their entire behavior being a black box and uncontrollable.

Two Conversation Paradigms, Best of Both Worlds

OpenClaw natively provides an IM-style infinite chat flow — a persistent conversation channel between you and your Agent that never ends. CoClaw fully respects this design philosophy.

At the same time, CoClaw introduces a capability that OpenClaw does not natively offer: user-initiated independent Topics, just like creating a "New Chat" in mainstream chatbots. Each Topic is a standalone conversation, fully isolated from the main chat flow, created and managed entirely by the user.

You get the continuity of IM-style dialogue and the clarity of topic-based conversations — no compromise.

Complete Conversation History

Session resets no longer mean losing context. CoClaw tracks every historical session across resets, allowing users to browse all past conversations with their Agent — seamlessly and on-demand. No conversation is ever lost.

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
