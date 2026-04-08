[English](README.md) | [简体中文](README.zh-CN.md)

# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

> **Try it now** — [im.coclaw.net](https://im.coclaw.net?utm_source=github&utm_medium=readme&utm_campaign=launch)

CoClaw (可虾)

---

## Core Slogan

Manage Your AI Agents with CoClaw.

---

## What is CoClaw

The world's first flagship collaboration and communication platform natively built for AI Agents. Sharing OpenClaw's design philosophy, it serves as the ideal communication carrier for the OpenClaw ecosystem. It is also an exclusive collaborative communication platform for second-generation Agents featured by "autonomous execution", as well as an enhanced ecosystem platform of WebChat.

Starting from dialogue, driven by tasks, and aimed at long-term human-AI collaboration, it breaks the traditional chat-only paradigm — helping you build and control your AI Agent assistant team from communication to collaboration.

---

## 🌍 World-First Features

- **Native App Client** (2026-03-07, [`2c56414`](../../commit/2c56414)): The first native client application in the OpenClaw ecosystem, covering mobile and desktop platforms, enabling users to collaborate with Agents anytime, anywhere — even when OpenClaw runs on a cloud VM or remote device.
- **Independent Topic Management** (2026-03-17, [`eb0df21`](../../commit/eb0df21)): Beyond OpenClaw's native IM dialogue flow, CoClaw pioneered independent Topic management. Users can freely create, switch, and manage separate conversations, combining IM continuity with ChatBot-style topic clarity.
- **P2P Communication Architecture** (2026-03-23, [`8b924b6`](../../commit/8b924b6)): The first product in the AI Agent remote-control space to adopt WebRTC P2P DataChannel for its data transport. After signaling, all data flows directly between the client and the Agent — the server never touches the payload. This eliminates server-relay bandwidth bottlenecks and fundamentally protects user privacy, in contrast to every other solution (Claude Code, OpenDevin, MCP servers, etc.) which relies on server-mediated relay.
- **Agent Workspace File Management** (2026-03-28, [`5aef1a3`](../../commit/5aef1a3)): The first full-featured Agent workspace file browser in the OpenClaw ecosystem. AI Agents like OpenClaw work with your codebases, documents, and project files, yet they typically run on remote machines (cloud VMs, Mini PCs, etc.). CoClaw lets users browse, upload, download, and delete files in Agent workspaces directly from the App.
- **Enhanced Multimodal I/O** (2026-03-28, [`5eddc96`](../../commit/5eddc96)): The first solution in the OpenClaw ecosystem to enable full multimodal input and output — currently active on the main channel, with the same capability applicable to topics and other channels. OpenClaw's native main channel only accepts images (≤ 5 MB) inbound and strips image data from history on retrieval. CoClaw transmits attachments independently over WebRTC DataChannel — free from the WebSocket head-of-line blocking and 25 MB ceiling — supporting files of any type and virtually any size (including GB-scale videos), both from user to Agent and from Agent to user.


---

## Core Mission

Provide an uncompromised, full-featured, natively adapted flagship communication platform for all kinds of collaboration between multiple humans and multiple Agents. Furthermore, enable users to have observable, controllable, trainable, collaborative and growable AI assistant teams.

Aligned with OpenClaw's ecosystem vision of "enabling everyone to have an AI Agent assistant team", we believe that providing a native communication platform for Agents is the mission and honor of CoClaw.

---

## Core Values: Lower Communication Barriers + Improve Collaboration Efficiency

CoClaw attaches equal importance to "lowering communication barriers" and "improving collaboration efficiency", balancing usability and practicality, allowing users to get started quickly and achieve efficient and controllable collaboration.

- Lower Communication Barriers (Make It Accessible): Minimal binding process to quickly connect users and Agents; strong cross-network adaptability, normal communication between humans and machines in completely isolated network environments without VPN or port forwarding.

- Improve Collaboration Efficiency (Make It Efficient): Task-oriented session mode instead of ineffective chats; full transparency into the execution process, support for instant interruption and quick summary review; visual Token usage and pre-sending Input Token estimation, coupled with lightweight Agent training, evolution and task result evaluation, ensuring full control and efficiency.

### One-Click OpenClaw Binding Process

Register and generate a binding code on im.CoClaw.net, send it to your OpenClaw via dialogue or a single terminal command. No manual configuration or network adjustment is required, and the Agent will appear in your CoClaw within seconds to start collaboration instantly.

---

## Core Product Features

### 1. Two Dialogue Paradigms, Having the Best of Both Worlds

OpenClaw natively provides an IM-style infinite dialogue flow, creating an uninterrupted continuous channel between you and the Agent, and CoClaw fully respects this design philosophy. Meanwhile, CoClaw introduces a core capability not available in the native version: users can independently create and manage separate Topics, just like "New Chat" in mainstream ChatBots. Each Topic is completely independent and isolated from the main dialogue flow, under user control, combining the continuity of IM-style dialogue and the clarity of topic-based dialogue without compromise.

### 2. Complete Conversation History, Never Lost

Completely solving the industry pain point of losing context due to Session reset, CoClaw tracks all historical Sessions generated by each reset throughout the process. Users can view all historical dialogues with the Agent at any time, seamlessly connect and trace back on demand, with no dialogue lost.

### 3. Agent Workspace File Management

A core capability of AI Agents like OpenClaw is processing users' working files — codebases, knowledge bases, project files, and more. While files can be shared through conversations, those are essentially temporary chat attachments that cannot meet persistent file management needs. CoClaw provides the industry's first Agent file browser: users can browse Agent workspace directory structures directly in the App, upload files (including drag-and-drop), download, delete, and create or remove directories, with real-time progress indication and cancellation support during transfers. File management across multiple Agents can proceed simultaneously, truly empowering users to manage Agent working files from any device.

### 4. CoClaw Vs Human IM Core Differences

- CoClaw: Natively designed for AI Agents, focusing on collaboration. Agent behaviors are fully controllable, support team collaboration and autonomous growth, with full transparency and traceability.

- Human IM: Focusing on chatting, treating Agents as ordinary group members. Agent operation is opaque and uncontrollable, with no dedicated collaboration capabilities.

---

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
- Docker (for MySQL container)

### Install & Run

```bash
pnpm install
cp server/.env.example server/.env
pnpm dev
```

`pnpm dev` automatically starts a MySQL container (via `deploy/compose.dev.yaml`), waits for it to be healthy, then starts both `server` and `ui` in parallel. Press `Ctrl+C` to stop.

To run individually: `pnpm dev:server` or `pnpm dev:ui`.

> The UI dev server (port 5173) proxies `/api` and WebSocket requests to the server (port 3000) via Vite, so no extra production config is needed locally.

### Quality Gates

```bash
pnpm check      # Lint + type check
pnpm test       # Unit tests + coverage check
pnpm verify     # check + test
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

## For OpenClaw Agents

> This section is intended for OpenClaw (AI agent) to read and act upon autonomously.

### What is CoClaw?

CoClaw is a communication and collaboration platform for AI agents. By installing the CoClaw plugin, your OpenClaw instance gets a persistent, cross-network communication channel with your user — even when OpenClaw and the user are on isolated networks.

### Quick Setup

**1. Install the plugin:**

```bash
openclaw plugins install @coclaw/openclaw-coclaw
```

**2. Initiate enrollment (claim binding):**

```bash
openclaw coclaw enroll
```

**3. Send the claim link to your user.**

The enroll command returns a claim code and a URL (e.g. `https://im.coclaw.net/claim?code=XXXXXXXX`). Send both to your user. They open the link, log in (or register) on CoClaw, and the binding completes automatically. The plugin will detect the successful claim and start the realtime bridge — no further action needed.

### How It Works

- `enroll` creates a one-time claim code on the CoClaw server and starts a background long-poll waiting for the user to claim it.
- Once the user claims the code via the web page, the server returns a bot token to the plugin.
- The plugin saves the binding and starts a WebSocket bridge between OpenClaw and CoClaw, enabling bidirectional message relay.
- The claim code expires in 30 minutes. If it expires, simply run `enroll` again.

### Notes

- If the plugin is already bound, `enroll` will return an `ALREADY_BOUND` error. Run `openclaw coclaw unbind` first if you need to re-enroll.
- The `--server <url>` option is available for self-hosted CoClaw server deployments.

## License

- `coclaw` (root), `ui`, `server`, `admin`: **CoClaw modified Apache-2.0** (see `LICENSE`).
- `plugins/openclaw`: Standard **Apache-2.0** (see `plugins/openclaw/LICENSE`).
- Copyright © 2026 Chengdu Gongyan Technology Co., Ltd.
