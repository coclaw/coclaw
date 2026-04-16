---
'@coclaw/ui': patch
---

Electron 壳子实施后的文档对齐 + 修 macOS 摄像头权限文案：

- 设计文档 `docs/designs/electron-desktop-shell.md`：builder 配置样本、构建命令、自动更新流程、package.json 样本同步为实施态（ESM 主进程 + electron-store@11、generic publish 指向 im.coclaw.net/releases/、preload.cjs、electron-builder.yaml 重命名、Phase 1 仅 DMG 声明）
- 根 `docs/versioning.md` 增 "Electron 壳子版本独立维护" 一节
- `ui/CLAUDE.md` 增 "Electron 桌面壳子开发" 小节（`electron:dev` / 构建命令 / WSL2 Wine 依赖 / 测试命令）
- `electron-builder.yaml` 的 `NSCameraUsageDescription` 改为 "CoClaw 需要使用摄像头拍摄图片用于对话"（去除不存在的视频通话描述，避免 App Store 审核被追问）
