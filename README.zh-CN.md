[English](README.md) | [简体中文](README.zh-CN.md)

# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

> **全球首个 [OpenClaw](https://github.com/openclaw/openclaw) 原生 IM 应用。**

CoClaw 是一款专为 OpenClaw 生态从零打造的即时通讯客户端。即使用户与其 OpenClaw 处于完全隔离的网络环境中，也无需 VPN 或端口转发即可正常对话。

功能上与 OpenClaw WebChat 类似，但 CoClaw 在平台集成深度和移动端优先的产品体验上做了更多扩展。

秉承 OpenClaw 的设计哲学，**你的 OpenClaw 实例是唯一的数据真相** —— 所有对话记录、Bot 人设、记忆等用户数据仅保存在你自己的设备上。CoClaw Server 不保存任何用户数据，仅维护用户与其 Bot 的绑定关系并充当通信桥梁。未来，你还可以将 OpenClaw 侧的数据（Bot 人设、记忆等）备份到自己的云盘，获得更多安心保障。

## 仓库结构

本项目采用 **pnpm monorepo** 组织：

| 工作区 | 说明 |
|--------|------|
| `server` | 后端服务（Express + Prisma + MySQL） |
| `ui` | 前端应用（Vue 3 + Nuxt UI 4 + Tailwind） |
| `admin` | 管理端（已预留，暂未开发） |
| `plugins/openclaw` | OpenClaw 插件 — 绑定、实时桥接、会话管理 |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm
- MySQL

### 安装与运行

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动 `server` 和 `ui`，按 `Ctrl+C` 停止。

单独运行：`pnpm dev:server` 或 `pnpm dev:ui`。

> UI 开发服务器（端口 5173）通过 Vite 将 `/api` 和 WebSocket 请求代理到后端（端口 3000），本地开发无需额外配置。

### 质量门禁

```bash
pnpm check      # 静态检查
pnpm test       # 单元测试
pnpm coverage   # 覆盖率检查（lines/functions/statements >= 70%，branches >= 60%）
pnpm verify     # check -> test -> coverage（一键执行）
```

### 开发流程

```bash
pnpm install
# 修改代码 + 更新测试/文档
pnpm verify
git commit -m "feat(scope): short summary"
```

## 文档

详见 [docs/](docs/README.md)，包含架构说明、决策记录、运维指南等。

## 许可证

- `coclaw`（根目录）、`ui`、`server`、`admin`：**CoClaw 修改版 Apache-2.0**（见 `LICENSE`）。
- `plugins/openclaw`：标准 **Apache-2.0**（见 `plugins/openclaw/LICENSE`）。
- Copyright © 2026 成都共演科技有限公司
