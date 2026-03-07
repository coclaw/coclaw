# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

**CoClaw** enables users to interact with their [OpenClaw](https://github.com/openclaw/openclaw) through the CoClaw platform, even when the two sides are network-isolated.

Functionally similar to OpenClaw WebChat, CoClaw extends the experience with additional platform-level and product-level capabilities.

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
