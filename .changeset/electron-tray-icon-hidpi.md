---
'@coclaw/ui': patch
---

Electron 托盘图标补 `@2x` 高分辨率版本：

- 新增 `build-resources/tray-icon@2x.png` 和 `tray-icon-unread@2x.png`（64×64），由 `build-resources/icon.png`（512×512 产品 logo）下采样生成，红点参数与现有 32×32 版本对齐（RGB 255,59,48；中心 (52,12)；半径 11）
- Electron 的 `nativeImage.createFromPath` 会按当前 DPI 自动选取 `@2x`——Windows 200% DPI、macOS Retina 下不再因强行放大 32×32 而糊
- `electron-builder.yaml` 的 `files` glob `build-resources/tray-icon*.png` 已覆盖新文件，无需改配置
- 无代码变更、无测试变更，仅资产追加
