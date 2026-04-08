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

- `ic_launcher.png` 和 `ic_launcher_round.png`：直接缩放到标准尺寸
- `ic_launcher_foreground.png`：**不能直接缩放到前景层尺寸**，必须处理安全区域（详见下方说明）

#### Adaptive Icon 前景层安全区域

Android Adaptive Icon 会对前景层施加遮罩（圆形/圆角方形等），裁掉外围约 33% 的区域。因此前景层的 logo 内容必须位于内部 66.7% 的安全区域内（72dp / 108dp），否则边缘会被裁切。

**处理方式**（两步）：
1. 先将源图缩放到安全区尺寸（safe zone size）
2. 再用 `extend` 在四周添加 padding 到前景层尺寸，背景色取自 `res/values/ic_launcher_background.xml`

| 密度 | 安全区尺寸 | Padding | 最终尺寸 |
|---|---|---|---|
| mdpi | 72x72 | 18px | 108x108 |
| hdpi | 108x108 | 27px | 162x162 |
| xhdpi | 144x144 | 36px | 216x216 |
| xxhdpi | 216x216 | 54px | 324x324 |
| xxxhdpi | 288x288 | 72px | 432x432 |

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

### 6. iOS (Capacitor) — ios/App/App/Assets.xcassets/AppIcon.appiconset/

| 文件 | 尺寸 | 说明 |
|---|---|---|
| `AppIcon-512@2x.png` | 1024x1024 | 唯一必需尺寸（Xcode 15+ 自动生成其余尺寸） |

- iOS 图标**不需要**安全区域 padding，直接缩放填满画布
- 系统自动应用圆角遮罩

## 生成命令模板

```bash
SRC="<源图片路径>"
PUB="ui/public"
ASSETS="ui/src/assets"
RES="ui/android/app/src/main/res"
IOS_ICON="ui/ios/App/App/Assets.xcassets/AppIcon.appiconset"
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
# 读取自适应图标背景色
BG=$(grep -oP '#[0-9A-Fa-f]+' "$RES/values/ic_launcher_background.xml")
TMP="/tmp/coclaw-fg-tmp.png"

for density_spec in "mdpi 48 72 18" "hdpi 72 108 27" "xhdpi 96 144 36" "xxhdpi 144 216 54" "xxxhdpi 192 288 72"; do
  read density std safe pad <<< "$density_spec"
  DIR="$RES/mipmap-$density"
  # 标准图标和圆形图标：直接缩放
  npx sharp-cli -i "$SRC" -o "$DIR/ic_launcher.png" resize $std $std
  npx sharp-cli -i "$SRC" -o "$DIR/ic_launcher_round.png" resize $std $std
  # 前景层：先缩放到安全区尺寸，再扩展 padding
  npx sharp-cli -i "$SRC" -o "$TMP" resize $safe $safe --fit contain
  npx sharp-cli -i "$TMP" -o "$DIR/ic_launcher_foreground.png" extend $pad $pad $pad $pad --background "$BG"
done
rm -f "$TMP"

# === 6. iOS (Capacitor) ===
npx sharp-cli -i "$SRC" -o "$IOS_ICON/AppIcon-512@2x.png" resize 1024 1024

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

- ICO 使用 `-icowe` 参数生成 Windows 可执行文件兼容格式（含多尺寸 BMP），避免 Electron/Tauri 打包后图标显示异常
- 更新后用 `ls -lh` 验证所有文件已生成且大小合理
- 如新增了 logo 相关文件（如新平台或 PWA manifest 引用新尺寸），需同步更新此 skill
