---
name: update-logo
description: 更新 CoClaw App logo/icon。Use when 用户上传新 logo 图片并要求更新。
---

# 更新 CoClaw Logo

当用户提供新的 logo 源图片时，需要更新以下所有位置的图像文件。收到源图片后直接执行，无需再确认。

## 源图片

用户会上传或指定一张源图片。要求**方形** PNG/JPG（脚本与各平台输出都按方形假设处理，非方形会拉伸/裁错——先造一张方形 master 再执行），建议 1024x1024 以上（macOS ICNS 中间图输出 1024，源图过小会放大）。

## 工具依赖

- `npx sharp-cli` — PNG 缩放
- `npx png2icons` — ICO/ICNS 生成（`-icowe` 生成 Windows EXE 兼容 ICO，`-icns` 生成 macOS ICNS，`-bz` 使用最佳质量）
- `python3` + PIL（Pillow）+ numpy — 仅给 Electron 的 `.ico`/`.icns` 烘焙圆角（见 `mask-electron-icons.py`）

## 硬规则：只圆 Electron 的 .ico/.icns

共享 master（`public/*`、`src/assets`、Android、iOS、以及 Electron 的 `icon.png`/`tray-icon*.png`）必须保持**方形满幅**——各 OS 自行套圆角/圆形遮罩，源图圆角会和系统遮罩叠加出双层圆角。**只有** Electron 桌面的 `build-resources/icon.ico`（Windows）和 `build-resources/icon.icns`（macOS）需要预烘圆角，由 `mask-electron-icons.py` 生成中间图后再喂给 png2icons。

`src-tauri/` 为早期评估残留（ui/AGENTS.md 已宣告勿用），更新 logo 时**跳过**其下所有图标。

## 需要更新的文件清单

清单路径相对 `ui/`；下方命令模板从**仓库根**执行。

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

每个 mipmap 密度目录下 3 个文件：`ic_launcher.png`、`ic_launcher_round.png`（直接缩放到标准尺寸）、`ic_launcher_foreground.png`（**不能直接缩放**，须按安全区处理，见下）。

| 密度 | 标准尺寸 | 前景层安全区 | Padding | 前景层最终 |
|---|---|---|---|---|
| mipmap-mdpi | 48x48 | 72x72 | 18px | 108x108 |
| mipmap-hdpi | 72x72 | 108x108 | 27px | 162x162 |
| mipmap-xhdpi | 96x96 | 144x144 | 36px | 216x216 |
| mipmap-xxhdpi | 144x144 | 216x216 | 54px | 324x324 |
| mipmap-xxxhdpi | 192x192 | 288x288 | 72px | 432x432 |

Adaptive Icon 会对前景层施加遮罩（圆形/圆角方形等），裁掉外围约 33%，logo 内容必须位于内部 66.7% 安全区（72dp / 108dp）。处理两步：先缩放源图到安全区尺寸，再用 `extend` 四周补 padding 到最终尺寸，背景色取自 `res/values/ic_launcher_background.xml`。

### 4. Electron — build-resources/

| 文件 | 尺寸/格式 | 说明 |
|---|---|---|
| `build-resources/icon.png` | 512x512 PNG | BrowserWindow icon，**方形满幅**（不圆角） |
| `build-resources/tray-icon.png` | 32x32 PNG | 系统托盘，方形 |
| `build-resources/tray-icon@2x.png` | 64x64 PNG | 托盘高分屏变体（Electron 按 `@2x` 命名自动取用） |
| `build-resources/tray-icon-unread.png` | 32x32 PNG | 托盘未读态（右上角未读角标），`ui/electron/tray.js` 引用 |
| `build-resources/tray-icon-unread@2x.png` | 64x64 PNG | 未读态高分屏变体 |
| `build-resources/icon.ico` | ICO | Windows 安装包/任务栏，**预烘全幅圆角矩形**（半径 22%） |
| `build-resources/icon.icns` | ICNS | macOS app bundle，**预烘方圆贴片**（squircle n=5，贴片 80%，内容裁 bbox+4% 呼吸边、最长边填满贴片 90%） |

> unread 版 = tray-icon 同图叠加未读角标，仓库无生成脚本，**需人工合成角标**（在新 tray-icon 基础上重做角标版，四个托盘文件一起换，避免新旧图标混用）。

### 5. iOS (Capacitor) — ios/App/App/Assets.xcassets/AppIcon.appiconset/

| 文件 | 尺寸 | 说明 |
|---|---|---|
| `AppIcon-512@2x.png` | 1024x1024 | 唯一必需尺寸（Xcode 15+ 自动生成其余尺寸） |

- iOS 图标**不需要**安全区域 padding，直接缩放填满画布；系统自动应用圆角遮罩

## 生成命令模板（从仓库根执行）

```bash
SRC="<源图片路径>"
PUB="ui/public"
ASSETS="ui/src/assets"
RES="ui/android/app/src/main/res"
IOS_ICON="ui/ios/App/App/Assets.xcassets/AppIcon.appiconset"
BUILD="ui/build-resources"

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
# 读取自适应图标背景色（grep -E 而非 -P，BSD/macOS grep 无 -P）
BG=$(grep -oE '#[0-9A-Fa-f]+' "$RES/values/ic_launcher_background.xml")
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

# === 4. Electron ===
# icon.png / tray 保持方形 master（绝不圆角）
npx sharp-cli -i "$SRC" -o "$BUILD/icon.png" resize 512 512
npx sharp-cli -i "$SRC" -o "$BUILD/tray-icon.png" resize 32 32
npx sharp-cli -i "$SRC" -o "$BUILD/tray-icon@2x.png" resize 64 64
# tray-icon-unread{,@2x}.png 无脚本：人工在上面两张基础上合成未读角标后放回
# .ico/.icns 先烘圆角中间图（win 512 圆角矩形 / mac 1024 方圆贴片），再喂 png2icons
SKILL_DIR=".agents/skills/update-logo"
mkdir -p /tmp/icon-build
python3 "$SKILL_DIR/mask-electron-icons.py" "$SRC" /tmp/icon-build/win.png /tmp/icon-build/mac.png
npx png2icons /tmp/icon-build/win.png "$BUILD/icon" -icowe -bz   # Windows 圆角 ICO
npx png2icons /tmp/icon-build/mac.png "$BUILD/icon" -icns -bz    # macOS 方圆 ICNS

# === 5. iOS (Capacitor) ===
npx sharp-cli -i "$SRC" -o "$IOS_ICON/AppIcon-512@2x.png" resize 1024 1024
```

## 注意事项

- ICO 使用 `-icowe` 参数生成 Windows 可执行文件兼容格式（含多尺寸 BMP），避免 Electron 打包后图标显示异常
- Electron 的 `.ico`/`.icns` 走 `mask-electron-icons.py` 预烘圆角；其余所有输出（含 `icon.png`、托盘、Android、iOS）保持方形满幅，**不要**把圆角中间图喂给它们（详见上方"硬规则"）
- 验证圆角：用 PIL 打开生成的 `.ico`/`.icns`，检查最大尺寸帧四角 alpha 为 0（透明）
- 更新后用 `ls -lh` 验证所有文件已生成且大小合理
- 如新增了 logo 相关文件（如新平台或 PWA manifest 引用新尺寸），需同步更新此 skill
