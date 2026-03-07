---
name: update-logo
description: 更新 CoClaw App logo/icon。当用户上传新 logo 图片并要求更新时使用。
---

# 更新 CoClaw Logo

当用户提供新的 logo 源图片时，需要更新以下所有位置的图像文件。

## 源图片

用户会上传或指定一张源图片（通常为 1024x1024 的 jpg/png）。

## 需要更新的文件清单

所有路径相对于 `ui/`：

### 1. public/ 下的 icon 和 favicon

从源图片缩放生成，使用 `npx sharp-cli` 处理：

| 文件 | 尺寸 | 格式 |
|---|---|---|
| `public/icon-512.png` | 512x512 | PNG |
| `public/icon-256.png` | 256x256 | PNG |
| `public/icon-192.png` | 192x192 | PNG |
| `public/icon-128.png` | 128x128 | PNG |
| `public/apple-touch-icon.png` | 180x180 | PNG |
| `public/favicon-32.png` | 32x32 | PNG |
| `public/favicon-16.png` | 16x16 | PNG |
| `public/favicon.ico` | 32x32 | PNG（从 favicon-32.png 复制） |

### 2. src/assets/ 下的 app logo

| 文件 | 说明 |
|---|---|
| `src/assets/coclaw-logo.jpg` | 直接从源图片复制（保持原始分辨率） |

## 生成命令模板

```bash
SRC="<源图片路径>"
PUB="ui/public"
ASSETS="ui/src/assets"

# PNG icons
npx sharp-cli -i "$SRC" -o "$PUB/icon-512.png" resize 512 512
npx sharp-cli -i "$SRC" -o "$PUB/icon-256.png" resize 256 256
npx sharp-cli -i "$SRC" -o "$PUB/icon-192.png" resize 192 192
npx sharp-cli -i "$SRC" -o "$PUB/icon-128.png" resize 128 128
npx sharp-cli -i "$SRC" -o "$PUB/apple-touch-icon.png" resize 180 180
npx sharp-cli -i "$SRC" -o "$PUB/favicon-32.png" resize 32 32
npx sharp-cli -i "$SRC" -o "$PUB/favicon-16.png" resize 16 16

# favicon.ico（从 favicon-32 复制）
npx sharp-cli -i "$PUB/favicon-32.png" -o "$PUB/favicon.ico"

# app logo（保持原始分辨率）
cp "$SRC" "$ASSETS/coclaw-logo.jpg"
```

## 注意事项

- 如果新增了 logo 相关文件（如 PWA manifest 引用的新尺寸），需同步更新此 skill
- 更新后用 `ls -lh` 验证所有文件已生成且大小合理
- `src/assets/bot-avatars/openclaw.svg` 是 bot 头像，不是 app logo，不在此流程中更新
