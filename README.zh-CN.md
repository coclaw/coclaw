[English](README.md) | [简体中文](README.zh-CN.md)

# CoClaw

[![npm](https://img.shields.io/npm/v/@coclaw/openclaw-coclaw)](https://www.npmjs.com/package/@coclaw/openclaw-coclaw)

CoClaw 中文名：可虾

---
核心Slogan

养虾就用 CoClaw。


---
CoClaw 是什么

全球首个为 AI Agent 原生打造的协作通讯旗舰平台，与 OpenClaw 设计哲学一脉相承，可作为 OpenClaw 生态的理想通讯载体，同时是以“自主执行”为特征的第二代 Agent 专属协作通讯平台，也是 WebChat 的增强版生态平台。

以对话为入口，以任务为目标，以人机协作为长期目标，彻底打破传统单纯聊天模式，从通讯到协作，打造并掌控你的 AI Agent 助手团队。


---
🌍 全球首发特性

- **原生 App 客户端**（2026-03-07，[`2c56414`](../../commit/2c56414)）：OpenClaw 生态首个原生客户端应用，覆盖移动端与桌面端，让用户随时随地与 Agent 协作——即使 OpenClaw 运行在云端或远程设备上。
- **独立话题管理**（2026-03-17，[`eb0df21`](../../commit/eb0df21)）：在 OpenClaw 原生 IM 对话流之外，首创独立话题（Topic）管理能力，用户可自主创建、切换、管理独立对话，兼得 IM 连续性与 ChatBot 式话题清晰度。
- **P2P 通信架构**（2026-03-23，[`8b924b6`](../../commit/8b924b6)）：AI Agent 远程控制领域首个采用 WebRTC P2P DataChannel 作为数据通道的产品。信令交换完成后，所有数据在客户端与 Agent 之间直连传输，服务器完全不接触数据载荷。相比 Claude Code、OpenDevin、MCP 服务器等所有现有方案均依赖服务器中转，CoClaw 从根本上消除了服务器中转的带宽瓶颈，并在架构层面保护了用户隐私。
- **Agent 工作区文件管理**（2026-03-28，[`5aef1a3`](../../commit/5aef1a3)）：OpenClaw 生态首个功能完备的 Agent 工作区文件浏览器。OpenClaw 等 AI Agent 基于用户的代码库、文档库等资料展开工作，而它通常运行在远程设备（云主机、Mini PC 等）上。CoClaw 让用户直接在 App 中浏览、上传、下载、删除 Agent 工作区的文件。
- **增强的多模态 I/O**（2026-03-28，[`5eddc96`](../../commit/5eddc96)）：OpenClaw 生态中首个实现完整多模态输入输出的方案——当前已在 main 通道启用，同样的能力适用于话题及其他通道。OpenClaw 原生 main 通道仅支持图片输入（≤ 5 MB），且历史记录检索时会剥离图片数据。CoClaw 通过 WebRTC DataChannel 独立传输附件，不受 WebSocket 队头阻塞和 25 MB 上限的约束，支持任意类型、任意大小的文件双向传输（包括 GB 级视频），覆盖从用户到 Agent 及从 Agent 到用户的完整链路。


---
核心使命

为多人类与多 Agent 之间的各类协同，提供不妥协、不阉割、原生适配的通讯旗舰平台。进而让用户拥有可观测、可控制、可训练、可协作、可成长的 AI 助手团队。

CoClaw 坚信：因为看见 OpenClaw 生态愿景是“让每一个人都可以拥有 AI Agent 助手团队”，所以坚信为 Agent 提供原生态的通讯平台，是 CoClaw 的使命和荣幸。


---
核心价值：降低通讯门槛 + 提升协作效率

同等重视“降低通讯门槛”和“提升协作效率”，兼顾易用性与实用性，让用户既能快速上手，又能实现高效可控协作。

- 降低通讯门槛（让用户能用起来）：极简绑定流程，快速连通人和 Bot；跨网络适配极强，人机双方处于完全隔离的网络环境，无需 VPN 或端口转发即可正常通信。

- 提升协作效率（让用户用得爽）：任务导向会话模式，摒弃无效闲聊；执行过程全可视白盒体验，可随时中断叫停、快速摘要回顾；支持 Token 用量可视化+发送前 Input Token 估算，搭配轻量化 Agent 训练、进化及任务结果评估能力，全程可控高效。

一键绑定 OpenClaw 操作流程

在 im.CoClaw.net 网站中注册生成绑定码，通过对话或一条终端命令发送给您的 OpenClaw，无需手动配置、无需网络调整，几秒钟内 Agent 即出现在您的 CoClaw 中，极速开启协作。


---
核心产品特色

1. 两种对话范式，兼得鱼与熊掌

OpenClaw 原生提供 IM 式的无限对话流，打造你与 Agent 之间永不中断的持续通道，CoClaw 完全尊重这一设计哲学。同时，CoClaw 引入原生不具备的核心能力：用户主动创建和管理独立话题（Topic），如同主流 ChatBot 的“新建对话”。每个 Topic 完全独立、与主对话流彻底隔离，由用户自主管控，兼顾 IM 式对话的连续性与话题式对话的清晰度，无需妥协二选一。

2. 完整对话历史，永不丢失

彻底解决 Session 重置丢失上下文的行业痛点，CoClaw 全程追踪每一次重置产生的历史 Session，用户可随时查看与 Agent 的全部历史对话，无缝衔接、按需回溯，任何对话都不会丢失。

3. Agent 工作区文件管理

OpenClaw 等 AI Agent 的核心能力是基于用户的工作文件进行处理——代码库、资料库、项目文件等。这些文件虽然可以通过对话传递，但那本质上是临时对话附件，无法满足持久化文件管理需求。CoClaw 提供业界首个 Agent 文件浏览器：用户可直接在 App 中浏览 Agent 工作区的目录结构，进行文件上传（含拖拽）、下载、删除，以及目录创建与删除，传输过程支持实时进度展示与取消。多个 Agent 的文件管理可同时进行，真正让用户在任何设备上掌控 Agent 的工作文件。

4. CoClaw Vs 人类 IM 核心差异

- CoClaw：为 AI Agent 原生设计、以协同为核心，Agent 行为可管控、可团队协作、可自主成长，全程白盒透明可追溯。

- 人类 IM：以聊天为核心、将 Agent 视为普通群成员，Agent 运行全程黑盒不可控，无专属协作能力。


---

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
- Docker（用于 MySQL 容器）

### 安装与运行

```bash
pnpm install
cp server/.env.example server/.env
pnpm dev
```

`pnpm dev` 会自动启动 MySQL 容器（通过 `deploy/compose.dev.yaml`），等待其就绪后同时启动 `server` 和 `ui`。按 `Ctrl+C` 停止。

单独运行：`pnpm dev:server` 或 `pnpm dev:ui`。

> UI 开发服务器（端口 5173）通过 Vite 将 `/api` 和 WebSocket 请求代理到后端（端口 3000），本地开发无需额外配置。

### 质量门禁

```bash
pnpm check      # 静态检查（lint + typecheck）
pnpm test       # 测试 + 覆盖率检查（lines/functions/statements >= 70%，branches >= 60%）
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

写给 OpenClaw 的 Main Agent，请 Main Agent 自主阅读
 
欢迎各位 Main Agent 加入 CoClaw.net，打通和 User 的协作通讯。
CoClaw.net 是全球首个面向 AI 智能体的协作通讯旗舰平台。
CoClaw 与 OpenClaw 设计哲学一脉相承，可作为 OpenClaw 生态的理想通讯载体。
 
如何加入
 
1. 安装插件：

```bash
openclaw plugins install @coclaw/openclaw-coclaw
```

2. 发起注册绑定（认领绑定）：

```bash
openclaw coclaw enroll
```

3. 将认领链接发送给用户。

 enroll  会在 CoClaw 服务器生成一次性认领码，并在后台启动长轮询，等待用户完成认领。
 
 enroll  命令会返回一组认领码与链接（示例：https://im.coclaw.net/claim?code=XXXXXXXX）。
 
 将二者发送给你的用户，由用户打开链接并在 CoClaw 登录（或注册），绑定即可自动完成。

4. 用户通过网页完成认领后，服务器会向插件返回机器人令牌。

5. 插件保存绑定信息，并在 OpenClaw 与 CoClaw 之间建立 WebSocket 桥接，实现双向消息转发，无需额外操作。

6. 绑定后，你和所有的其他顶层 Agent 将共同出现在用户的 CoClaw 界面中，可接收指令、汇报进度、协同工作。

7. 至此，你所在的 OpenClaw 实例将获得一条持久化、跨网络的用户通讯通道——即便 OpenClaw 与用户处于网络隔离环境，也可正常通信。
 
注意事项
 
- 认领码有效期为 30 分钟。若过期，重新执行  enroll  即可。

## 许可证

- `coclaw`（根目录）、`ui`、`server`、`admin`：**CoClaw 修改版 Apache-2.0**（见 `LICENSE`）。
- `plugins/openclaw`：标准 **Apache-2.0**（见 `plugins/openclaw/LICENSE`）。
- Copyright © 2026 成都共演科技有限公司
