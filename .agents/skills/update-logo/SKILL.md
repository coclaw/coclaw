---
name: update-logo
description: 更新 CoClaw App logo/icon。当用户上传新 logo 图片并要求更新时使用。
---

# 更新 CoClaw Logo

当用户提供新的 logo 源图片时，需要更新以下所有位置的图像文件。收到源图片后直接执行，无需再确认。

## 源图片

用户会上传或指定一张源图片（建议 512x512 以上的 PNG/JPG）。

## 工具依赖

- `npx sharp-cli` — PNG 缩放
- `npx png2icons` — ICO/ICNS 生成（`-icowe` 生成 Windows EXE 兼容 ICO，`-icns` 生成 macOS ICNS，`-bz` 使用最佳质量）

## 需要更新的文件清单

所有路径相对于 `ui/`。

### 1. Web/PWA — public/

| 文件 | 尺寸 | 说明 |
|---|---|---|
| `public/icon-512.png` | 512x512 | PWA |
| `public/icon-256.png` | 256x256 | PWA |
| `public/icon-192.png` | 192x192 | PWA |
| `public/icon-128.png` | 128x128 | PWA |
| `public/apple-touch-icon.png` | 180x180 | iOS Safari |
| `public/favicon-32.png` | 32x32 | Favicon |
| `public/favicon-16.png` | 16x16 | Favicon |
| `public/favicon.ico` | — | 从 favicon-32.png 复制 |

### 2. App Logo — src/assets/

| 文件 | 说明 |
|---|---|
| `src/assets/coclaw-logo.jpg` | sharp-cli 直接转换（保持原始分辨率） |

### 3. Android (Capacitor) — android/app/src/main/res/

每个 mipmap 密度目录下 3 个文件：`ic_launcher.png`、`ic_launcher_round.png`、`ic_launcher_foreground.png`。

| 密度 | 标准尺寸 | 前景层尺寸 |
|---|---|---|
| mipmap-mdpi | 48x48 | 108x108 |
| mipmap-hdpi | 72x72 | 162x162 |
| mipmap-xhdpi | 96x96 | 216x216 |
| mipmap-xxhdpi | 144x144 | 324x324 |
| mipmap-xxxhdpi | 192x192 | 432x432 |

- `ic_launcher.png` 和 `ic_launcher_round.png` 使用标准尺寸
- `ic_launcher_foreground.png` 使用前景层尺寸

### 4. Electron — build-resources/

| 文件 | 尺寸/格式 | 说明 |
|---|---|---|
| `build-resources/icon.png` | 512x512 PNG | BrowserWindow icon |
| `build-resources/tray-icon.png` | 32x32 PNG | 系统托盘 |
| `build-resources/icon.ico` | ICO | Windows 安装包/任务栏 |
| `build-resources/icon.icns` | ICNS | macOS app bundle |

### 5. Tauri — src-tauri/icons/

| 文件 | 尺寸 |
|---|---|
| `src-tauri/icons/icon.png` | 512x512 |
| `src-tauri/icons/32x32.png` | 32x32 |
| `src-tauri/icons/128x128.png` | 128x128 |
| `src-tauri/icons/128x128@2x.png` | 256x256 |
| `src-tauri/icons/tray-icon.png` | 32x32 |
| `src-tauri/icons/icon.ico` | ICO |
| `src-tauri/icons/icon.icns` | ICNS |
| `src-tauri/icons/StoreLogo.png` | 50x50 |
| `src-tauri/icons/Square30x30Logo.png` | 30x30 |
| `src-tauri/icons/Square44x44Logo.png` | 44x44 |
| `src-tauri/icons/Square71x71Logo.png` | 71x71 |
| `src-tauri/icons/Square89x89Logo.png` | 89x89 |
| `src-tauri/icons/Square107x107Logo.png` | 107x107 |
| `src-tauri/icons/Square142x142Logo.png` | 142x142 |
| `src-tauri/icons/Square150x150Logo.png` | 150x150 |
| `src-tauri/icons/Square284x284Logo.png` | 284x284 |
| `src-tauri/icons/Square310x310Logo.png` | 310x310 |

## 生成命令模板

```bash
SRC="<源图片路径>"
PUB="ui/public"
ASSETS="ui/src/assets"
RES="ui/android/app/src/main/res"
BUILD="ui/build-resources"
TAURI="ui/src-tauri/icons"

# === 1. Web/PWA ===
npx sharp-cli -i "$SRC" -o "$PUB/icon-512.png" resize 512 512
npx sharp-cli -i "$SRC" -o "$PUB/icon-256.png" resize 256 256
npx sharp-cli -i "$SRC" -o "$PUB/icon-192.png" resize 192 192
npx sharp-cli -i "$SRC" -o "$PUB/icon-128.png" resize 128 128
npx sharp-cli -i "$SRC" -o "$PUB/apple-touch-icon.png" resize 180 180
npx sharp-cli -i "$SRC" -o "$PUB/favicon-32.png" resize 32 32
npx sharp-cli -i "$SRC" -o "$PUB/favicon-16.png" resize 16 16
cp "$PUB/favicon-32.png" "$PUB/favicon.ico"

# === 2. App Logo ===
npx sharp-cli -i "$SRC" -o "$ASSETS/coclaw-logo.jpg"

# === 3. Android (Capacitor) ===
for density_size in "mdpi 48 108" "hdpi 72 162" "xhdpi 96 216" "xxhdpi 144 324" "xxxhdpi 192 432"; do
  read density std fg <<< "$density_size"
  DIR="$RES/mipmap-$density"
  npx sharp-cli -i "$SRC" -o "$DIR/ic_launcher.png" resize $std $std
  npx sharp-cli -i "$SRC" -o "$DIR/ic_launcher_round.png" resize $std $std
  npx sharp-cli -i "$SRC" -o "$DIR/ic_launcher_foreground.png" resize $fg $fg
done

# === 4. Electron ===
npx sharp-cli -i "$SRC" -o "$BUILD/icon.png" resize 512 512
npx sharp-cli -i "$SRC" -o "$BUILD/tray-icon.png" resize 32 32
npx png2icons "$SRC" "$BUILD/icon" -icowe -bz
npx png2icons "$SRC" "$BUILD/icon" -icns -bz

# === 5. Tauri ===
npx sharp-cli -i "$SRC" -o "$TAURI/icon.png" resize 512 512
npx sharp-cli -i "$SRC" -o "$TAURI/32x32.png" resize 32 32
npx sharp-cli -i "$SRC" -o "$TAURI/128x128.png" resize 128 128
npx sharp-cli -i "$SRC" -o "$TAURI/128x128@2x.png" resize 256 256
npx sharp-cli -i "$SRC" -o "$TAURI/tray-icon.png" resize 32 32
npx sharp-cli -i "$SRC" -o "$TAURI/StoreLogo.png" resize 50 50
for sq in 30 44 71 89 107 142 150 284 310; do
  npx sharp-cli -i "$SRC" -o "$TAURI/Square${sq}x${sq}Logo.png" resize $sq $sq
done
npx png2icons "$SRC" "$TAURI/icon" -icowe -bz
npx png2icons "$SRC" "$TAURI/icon" -icns -bz
```

## 注意事项

- `src/assets/bot-avatars/openclaw.svg` 是 bot 头像，不是 app logo，不在此流程中更新
- ICO 使用 `-icowe` 参数生成 Windows 可执行文件兼容格式（含多尺寸 BMP），避免 Electron/Tauri 打包后图标显示异常
- 更新后用 `ls -lh` 验证所有文件已生成且大小合理
- 如新增了 logo 相关文件（如新平台或 PWA manifest 引用新尺寸），需同步更新此 skill
