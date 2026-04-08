# ADR: 移动端与桌面端框架选择

- **状态**：已采纳（桌面端部分已修订，见下方说明）
- **日期**：2026-03-08（桌面端修订：2026-04-08）
- **决策者**：团队

## 背景

CoClaw 前端（`ui`）是基于 Vue 3 + Vite + Nuxt UI 4 的 SPA，采用移动端优先设计。需要将其包装为 Android/iOS App 以及 Windows/macOS 桌面应用。

选型要求：框架稳定可靠、久经考验、社区口碑良好、仍在积极更新。

## 决策

### 移动端（Android + iOS）：Capacitor

- **原理**：将现有 SPA 打包到原生 WebView 中运行，通过插件桥接调用原生能力
- **与项目契合度**：专为"已有 Web 应用 → 原生 App"场景设计，对 Vue 3 + Vite 开箱即用
- **成熟度**：Ionic 团队维护，2019 年发布 v1，当前 v6+，npm 周下载量百万级
- **社区**：活跃，GitHub 12k+ stars，文档完善，插件生态丰富（相机、推送、文件系统等）
- **迁移成本**：极低，几乎不需要改动现有前端代码

### 桌面端（Windows + macOS）：Electron

> **修订说明**（2026-04-08）：原决策选择 Tauri v2，后因 Rust 维护负担、无法在 WSL2 交叉编译 Windows .exe、原生 API 缺口等问题，改为 Electron。详见 [Electron 桌面壳设计](../designs/electron-desktop-shell.md)。

- **原理**：Node.js 后端 + Chromium，thin-shell 架构——壳仅加载远程 UI（`https://im.coclaw.net`）并桥接原生能力
- **与项目契合度**：全 JS 技术栈，WSL2 可直接构建 Windows .exe；`setOverlayIcon`/`setBadgeCount`/`flashFrame` 等通知能力开箱即用
- **成熟度**：GitHub 115k+ stars，工业级生态
- **代价**：安装包 80-150 MB（thin-shell 模式下可通过 remote load 减少更新频率）

### 整体架构

| 平台 | 框架 | 改动量 |
|------|------|--------|
| Android / iOS | Capacitor | 几乎零改动，加壳打包 |
| Windows / macOS | Electron | thin-shell 远程加载，前端代码共用 |

两个框架都直接消费 `vite build` 的产物，前端代码完全共用。

## 排除的方案

| 方案 | 排除原因 |
|------|----------|
| Cordova | 已进入维护模式，社区萎缩，Capacitor 是其精神继承者 |
| Tauri v2 Mobile | 移动端支持 2024 年才正式发布，生态和踩坑经验远不如 Capacitor |
| React Native / Flutter | 需要重写 UI 层，不适合已有 Vue SPA |
| Electron（初版） | 原认为包体积大且不需定制浏览器能力，但后续发现 Tauri 的 Rust 维护成本和交叉编译困难更严重，故最终选回 Electron |
| Tauri v2（桌面端） | 原选方案，因 Rust 维护负担、WSL2 无法交叉编译、原生 API 缺口而放弃（详见 `designs/electron-desktop-shell.md`） |
