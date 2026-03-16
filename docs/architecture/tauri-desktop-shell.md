# Tauri v2 桌面壳子应用设计方案

> 状态：定稿
> 创建时间：2026-03-14
> 适用范围：Windows + macOS 桌面端

## 关键决策记录

以下决策已确认，记录备选方案供后续参考。

### D1. 开发者账号类型

**决策**：两个平台均使用公司/组织账号，与 APK 发布主体一致（成都共演科技有限公司）。

| 平台 | 账号类型 | 费用 | 备注 |
|---|---|---|---|
| Microsoft Store | 公司 | $99 一次性 | 个人账号自 2025.9 起免费，但以个人名义发布 |
| Apple Developer | 组织 | $99/年 | 需 D-U-N-S 编号；个人账号同价但以真人名义发布 |

### D2. 代码签名策略

**决策**：初期 Microsoft Store 走 MSIX 路径（商店自动签名），官网直接下载版使用 OV 证书。

| 备选方案 | 优势 | 劣势 |
|---|---|---|
| **OV 证书（当前选择）** | 便宜，适合初期 | SmartScreen 需时间积累信誉，初期有"未知发布者"警告 |
| EV 证书 | 立即获得 SmartScreen 信任 | 昂贵，需硬件密钥（HSM），如 Azure Key Vault |
| Azure Code Signing | 云端签名，无需本地 HSM | 需 Azure 订阅，流程较复杂 |

**升级路径**：待用户量增长或预算充足后，从 OV 升级到 EV 证书以消除 SmartScreen 警告。

### D3. 自动更新端点

**决策**：使用 GitHub Releases 作为更新检查端点。

| 备选方案 | 优势 | 劣势 |
|---|---|---|
| **GitHub Releases（当前选择）** | 零成本，Tauri 原生支持，与代码仓库一体 | 依赖 GitHub 可用性；国内访问可能受限 |
| 自建更新服务 | 完全可控，可定制灰度发布 | 需要维护额外服务 |
| CrabNebula Cloud | Tauri 官方推荐的云服务 | 付费服务 |

**注意**：若后续国内用户反馈更新检查失败，考虑迁移到自建端点（如 `https://releases.coclaw.net/...`）。

### D4. macOS 最低版本

**决策**：最低支持 macOS 12.0 (Monterey)，构建 Universal Binary（Intel + Apple Silicon）。

| 备选方案 | 覆盖范围 | 备注 |
|---|---|---|
| macOS 11.0 (Big Sur) | 更广 | 部分 Tauri v2 功能可能不稳定 |
| **macOS 12.0 (Monterey)（当前选择）** | 覆盖 2021 年至今所有 Mac | Apple Silicon 原生支持的起始版本 |
| macOS 13.0 (Ventura) | 较窄 | 可减少兼容性测试负担，但排除较旧设备 |

## 1. 设计目标

与 Android APK 壳子一致，遵循 **"薄壳远程加载"** 架构：

1. **壳子尽量少升级**：一次性预埋所有可预见的原生能力（权限、插件、系统集成），后续功能迭代仅通过 Web 端（`https://im.coclaw.net`）更新
2. **前端代码零分歧**：桌面壳子与 Web/Android 共用同一套 Vue SPA，不维护平台专属 UI 代码
3. **覆盖完整能力矩阵**：麦克风、摄像头、文件系统、剪贴板、通知、分享、Deep Link、后台常驻（系统托盘）、自动更新
4. **上架应用商店**：Microsoft Store + Apple Mac App Store

## 2. 技术选型回顾

| 项 | 选型 | 依据 |
|---|---|---|
| 框架 | Tauri v2 | ADR `docs/decisions/adr-mobile-desktop-framework.md` |
| Windows WebView | WebView2 (Edge/Chromium) | Win11 预装，Win10 安装时自动下载 |
| macOS WebView | WKWebView (WebKit/Safari) | macOS 系统内置 |
| 后端语言 | Rust | Tauri 框架要求 |
| 安装包 (Windows) | NSIS (.exe) + MSIX (商店) | NSIS 为通用安装包；MSIX 为商店分发 |
| 安装包 (macOS) | DMG (直接下载) + PKG (商店) | 标准分发格式 |

## 3. 壳子架构

```
┌─────────────────────────────────┐
│         Tauri Shell (Rust)      │
│  ┌───────────────────────────┐  │
│  │ WebView2 / WKWebView     │  │
│  │  loads im.coclaw.net      │  │
│  │  (Vue SPA + Tauri IPC)   │  │
│  └───────────────────────────┘  │
│  ┌─────────┐ ┌───────────────┐  │
│  │ 系统托盘 │ │  Tauri 插件   │  │
│  └─────────┘ └───────────────┘  │
│  ┌─────────────────────────────┐│
│  │ Capabilities (ACL)          ││
│  │ 预埋全部所需权限             ││
│  └─────────────────────────────┘│
└─────────────────────────────────┘
```

### 3.1 远程加载模式

与 Android Capacitor 壳子完全一致：

- `tauri.conf.json` 不指定 `frontendDist`（不打包 Web 资源）
- 主窗口加载 `https://im.coclaw.net`
- 通过 capability 的 `remote.urls` 字段授权远程 URL 访问 Tauri IPC
- Web 更新即时生效，壳子无需重新分发

### 3.2 与 Android 壳子的对应关系

| Android 壳子 | Tauri 桌面壳子 | 说明 |
|---|---|---|
| `capacitor.config.ts` server.url | `tauri.conf.json` window URL + remote capability | 远程加载入口 |
| AndroidManifest.xml 权限 | `src-tauri/capabilities/*.json` | 能力预声明 |
| Capacitor 插件 | Tauri 官方插件 | 原生桥接 |
| KeepAliveService | 系统托盘常驻 | 后台保活（桌面端实现方式不同） |
| Intent Filter (Deep Link) | `tauri-plugin-deep-link` | `coclaw://` 协议 |
| Intent Filter (Share Target) | 暂无对等方案 | 桌面端无标准 Share Target 机制 |
| `Capacitor.isNativePlatform()` | `isTauri()` from `@tauri-apps/api/core` | 平台检测 |
| `@capacitor/status-bar` | 不适用 | 桌面端无状态栏概念 |
| Safe area insets | 不适用 | 桌面端无刘海/安全区 |

## 4. 项目结构

在 `ui/` 目录下新增 `src-tauri/`：

```
ui/
├── src-tauri/
│   ├── Cargo.toml                    # Rust 依赖声明
│   ├── tauri.conf.json               # 主配置（共用）
│   ├── tauri.macos.conf.json         # macOS 平台覆盖（overlay 标题栏、DMG 打包）
│   ├── build.rs                      # Tauri 构建脚本
│   ├── src/
│   │   ├── main.rs                   # 入口（调用 lib.rs）
│   │   ├── lib.rs                    # 注册插件、系统托盘、窗口事件
│   │   └── tray.rs                   # 系统托盘逻辑
│   ├── capabilities/
│   │   └── main.json                 # 主窗口能力声明（共用，含 remote URLs 限制）
│   ├── icons/                        # 应用图标（多尺寸，tauri init 自动生成）
│   │   ├── icon.ico, icon.icns, icon.png, 32x32.png, 128x128.png, ...
│   │   ├── Square*.png               # Windows Store 图标
│   │   └── tray-icon.png             # 系统托盘图标
│   ├── Entitlements.plist            # macOS 沙箱权限（预置）
│   └── Info.plist                    # macOS 权限描述文字（预置）
├── scripts/
│   ├── tauri-build.sh                # Bash 构建 wrapper（自动加载签名密钥）
│   └── tauri-build.ps1               # PowerShell 构建 wrapper（Windows 用）
├── src/
│   └── utils/
│       ├── platform.js               # 统一平台检测（Capacitor / Tauri / Web）
│       ├── tauri-app.js              # Tauri 壳子初始化（Deep Link 等）
│       ├── tauri-notify.js           # Tauri 桌面端 IM 通知能力
│       └── capacitor-app.js          # Capacitor 壳子初始化（现有）
├── android/                          # Android 壳子（现有）
└── ...
```

## 5. 配置详述

### 5.1 tauri.conf.json（主配置）

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "CoClaw",
  "version": "1.0.0",
  "identifier": "net.coclaw.im",
  "mainBinaryName": "coclaw",
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "CoClaw",
        "width": 420,
        "height": 780,
        "minWidth": 360,
        "minHeight": 640,
        "resizable": true,
        "center": true,
        "url": "https://im.coclaw.net",
        // macOS 覆盖配置中设置 titleBarStyle
        "decorations": true
      }
    ],
    "security": {
      "capabilities": ["main-capability"]
    },
    "withGlobalTauri": true,
    "trayIcon": {
      "iconPath": "icons/tray-icon.png",
      "tooltip": "CoClaw"
    }
  },
  "build": {
    // 无 frontendDist —— 远程加载模式
    // 开发时使用本地前端
    "devUrl": "http://localhost:5173"
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico",
      "icons/icon.icns",
      "icons/icon.png"
    ],
    "resources": [],
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      },
      "nsis": {
        "installMode": "currentUser",
        "displayLanguageSelector": true,
        "languages": ["SimpChinese", "English"]
      },
      "certificateThumbprint": null,
      "timestampUrl": "http://timestamp.digicert.com"
    },
    "macOS": {
      "minimumSystemVersion": "12.0",
      "signingIdentity": null,
      "hardenedRuntime": true,
      "entitlements": "./Entitlements.plist",
      "dmg": {
        "windowSize": { "width": 660, "height": 400 },
        "appPosition": { "x": 180, "y": 170 },
        "applicationFolderPosition": { "x": 480, "y": 170 }
      }
    }
  },
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["coclaw"]
      }
    },
    "updater": {
      "pubkey": "",
      "endpoints": [
        "https://github.com/AYuaner/coclaw/releases/latest/download/latest.json"
      ]
    }
  }
}
```

> **注**：`withGlobalTauri: true` 使远程页面可通过 `window.__TAURI__` 访问 Tauri API。因为我们是远程加载模式，无法使用 ES module import 的 `@tauri-apps/api`（那需要本地打包），所以必须开启此选项。

### 5.2 tauri.windows.conf.json（Windows 覆盖）

```jsonc
{
  // Windows 专属覆盖，与主配置 deep merge
}
```

初期无需覆盖。若需为 Microsoft Store 构建单独配置，创建 `tauri.store.conf.json`：

```jsonc
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

### 5.3 tauri.macos.conf.json（macOS 覆盖）

```jsonc
{
  "app": {
    "windows": [
      {
        "label": "main",
        "titleBarStyle": "overlay",
        "hiddenTitle": true
      }
    ]
  },
  "bundle": {
    "targets": ["dmg"]
  }
}
```

macOS 使用 `overlay` 标题栏风格（保留红绿灯按钮，隐藏标题文字），更贴合原生体验。

## 6. 能力预埋（Capabilities）

### 6.1 主能力文件 `capabilities/main.json`

对标 Android APK 的权限预埋策略，一次性声明所有可预见能力：

```jsonc
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-capability",
  "description": "主窗口完整能力集，预埋所有可预见的原生能力",
  "windows": ["main"],
  "remote": {
    "urls": ["https://*.coclaw.net"]
  },
  "permissions": [
    // ---- 核心 ----
    "core:default",
    "core:window:default",
    "core:window:allow-close",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-minimize",
    "core:window:allow-unminimize",
    "core:window:allow-set-title",
    "core:webview:default",
    "core:event:default",

    // ---- 文件系统（对标 @capacitor/filesystem）----
    "fs:default",
    {
      "identifier": "fs:allow-read-file",
      "allow": [
        { "path": "$DOWNLOAD/**/*" },
        { "path": "$DOCUMENT/**/*" },
        { "path": "$PICTURE/**/*" },
        { "path": "$VIDEO/**/*" },
        { "path": "$AUDIO/**/*" },
        { "path": "$HOME/**/*" },
        { "path": "$DESKTOP/**/*" }
      ]
    },
    {
      "identifier": "fs:allow-write-file",
      "allow": [
        { "path": "$DOWNLOAD/**/*" },
        { "path": "$DOCUMENT/**/*" },
        { "path": "$APPDATA/**/*" }
      ]
    },
    "fs:allow-exists",
    "fs:allow-mkdir",
    "fs:allow-read-dir",

    // ---- 文件对话框（对标 @capacitor/filesystem 选择文件）----
    "dialog:default",

    // ---- 剪贴板（对标 @capacitor/clipboard）----
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-read-image",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-write-html",
    "clipboard-manager:allow-write-image",
    "clipboard-manager:allow-clear",

    // ---- 通知（对标 @capacitor/local-notifications）----
    "notification:default",

    // ---- 系统 Shell（打开外部链接，对标 @capacitor/browser）----
    "shell:allow-open",

    // ---- Deep Link（对标 Android coclaw:// scheme）----
    "deep-link:default",

    // ---- 自动更新 ----
    "updater:default",

    // ---- OS 信息（平台检测）----
    "os:default",

    // ---- 持久化存储（用户偏好，如托盘行为设置）----
    "store:default",

    // ---- 窗口状态保存/恢复 ----
    "window-state:default",

    // ---- 进程控制（更新后重启）----
    "process:default",

    // ---- HTTP 代理（绕过 CORS，备用）----
    "http:default",

    // ---- 日志 ----
    "log:default",

    // ---- 全局快捷键（预埋，后续可用于快捷唤起等）----
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered"
  ]
}
```

### 6.2 能力预埋与 Android 权限的对照

| Android 权限/能力 | Tauri 能力 | 说明 |
|---|---|---|
| INTERNET | 无需声明（WebView 默认） | 桌面无此限制 |
| CAMERA | WebView2/WKWebView 自行处理 | 无 Tauri 权限，靠 WebView 层 |
| RECORD_AUDIO | WebView2/WKWebView 自行处理 | 同上 |
| MODIFY_AUDIO_SETTINGS | 不适用 | Android Capacitor 专属问题 |
| READ_MEDIA_* / STORAGE | `fs:allow-read-file` + scoped paths | Tauri 细粒度路径控制 |
| POST_NOTIFICATIONS | `notification:default` | 桌面通知 |
| FOREGROUND_SERVICE / WAKE_LOCK | 系统托盘常驻 | 桌面端不需要前台服务 |
| VIBRATE | 不适用 | 桌面无震动 |
| ACCESS_NETWORK_STATE | 浏览器 `navigator.onLine` | Web API 即可 |
| Deep Link (coclaw://) | `deep-link:default` | 协议一致 |
| Share Target | 无直接对等 | 桌面端无标准接收分享机制 |

### 6.3 麦克风/摄像头权限处理

桌面端与 Android 处理方式不同：

**Windows (WebView2)**：
- 麦克风/摄像头通过 Web API (`getUserMedia`) 访问
- WebView2 默认弹出浏览器风格的权限提示
- Rust 端可通过监听 `PermissionRequested` 事件自动批准，避免重复弹窗
- **建议实现**：首次请求时弹系统提示，用户同意后 Rust 端记住选择，后续自动批准

**macOS (WKWebView)**：
- 需在 `Info.plist` 声明 `NSMicrophoneUsageDescription` 和 `NSCameraUsageDescription`
- 需在 `Entitlements.plist` 声明 `com.apple.security.device.audio-input` 和 `com.apple.security.device.camera`
- **已知问题**：wry#1195 — WKWebView 的 `getUserMedia()` 权限弹窗行为不一致，可能不弹窗或双重弹窗
- **缓解措施**：测试实际行为；若不弹窗，考虑使用 `tauri-plugin-macos-permissions` 主动请求权限

## 7. 系统托盘

### 7.1 功能设计

对标 Android KeepAliveService 的"后台保活"能力，桌面端通过系统托盘实现：

| 行为 | 默认 | 用户可配置 |
|---|---|---|
| 关闭窗口时 | 最小化到托盘（不退出） | 可在设置中切换为"直接退出" |
| 托盘图标左键单击 | 显示/隐藏主窗口 | — |
| 托盘右键菜单 | 显示窗口 / 退出 | — |
| 开机自启 | 关闭 | 可在设置中开启（TODO，暂不实现） |

### 7.2 托盘菜单结构

```
CoClaw（tooltip）
├── 显示窗口 / Show Window
├── ─────────（分隔线）
└── 退出 / Quit
```

菜单语言跟随系统语言或应用语言设置。

**主流 IM 参考**（均在托盘右键菜单中提供"退出"）：
- Discord：Open / Mute / Deafen / Quit
- Telegram：Open / Quit
- WeChat：仅"退出微信"
- Slack：Show / Preferences / Quit

### 7.3 Rust 实现要点

```rust
// src/tray.rs 核心逻辑概要

// 关闭窗口事件 → 根据用户设置决定隐藏或退出
fn on_close_requested(window, api) {
    let minimize_to_tray = read_user_preference("minimize_to_tray", true);
    if minimize_to_tray {
        window.hide();
        api.prevent_close();
        // Windows: skip_taskbar(true)
        // macOS: 不隐藏 dock 图标（保留用户点击 dock 恢复窗口的能力）
    }
    // else: 默认关闭行为（退出应用）
}

// 托盘图标点击 → 切换窗口显示
fn on_tray_click(window) {
    if window.is_visible() {
        window.hide();
    } else {
        window.show();
        window.set_focus();
    }
}
```

### 7.4 壳子相关设置的 UX 方案

**结论**：不设独立的原生设置面板。所有壳子相关设置统一放在 **Web 应用内部的设置页面**（UserPage 或独立 SettingsPage），通过 Tauri IPC 调用原生能力。

这是所有主流桌面 IM 的一致做法：
- Discord：User Settings → App Settings → Windows Settings（minimize to tray、start on boot）
- Slack：Preferences → Advanced → "Leave app running in notification area"
- WhatsApp Desktop：Settings → General → "Minimise to system tray"
- Telegram：Settings → General → "Use system tray icon"

**无任何主流 IM 使用"首次关闭时弹窗询问"模式**，全部是设置页中的持久开关。

需要在 Web 设置页面中暴露的壳子设置项（仅 Tauri 环境下显示）：

| 设置项 | 默认值 | 存储 | 说明 |
|---|---|---|---|
| 关闭窗口时最小化到托盘 | 开启 | `tauri-plugin-store` | 控制 X 按钮行为 |
| 开机自启（TODO） | 关闭 | 系统注册表/plist | 后续实现 |

### 7.5 用户偏好存储

使用 `@tauri-apps/plugin-store` 持久化用户偏好：

```js
// 前端设置页面
const { Store } = window.__TAURI__.store;
const store = await Store.load('settings.json');
await store.set('minimize_to_tray', true);
await store.save();
```

Rust 端在 `on_close_requested` 时读取此值。

### 7.6 托盘图标规格

| 平台 | 格式 | 尺寸 | 备注 |
|---|---|---|---|
| Windows | ICO 或 PNG | 16×16 px | 系统自动缩放 |
| macOS | PNG (template image) | 44×44 px (@2x) | 设置 `icon_as_template(true)`，自动适配暗/亮模式 |

macOS 的 template image 只需提供单色图标（黑色+透明），系统根据菜单栏主题自动反转颜色。

### 7.7 托盘 Tooltip 动态更新

托盘图标的 hover tooltip 可从 Web 端动态更新，用于显示应用状态信息（如未读消息数）：

```js
// Web 端控制
const tray = await window.__TAURI__.tray.TrayIcon.getById('main-tray');
await tray.setTooltip('CoClaw - 3 条未读消息');
// 或恢复默认
await tray.setTooltip('CoClaw');
```

| 平台 | 支持情况 |
|---|---|
| Windows | 支持，hover 时显示文字提示，最长 128 字符 |
| macOS | 支持（`NSStatusItem.button.toolTip`），但 macOS 用户较少依赖此特性 |
| Linux | 不支持（libappindicator 限制） |

## 8. IM 通知与注意力机制

作为 IM 应用，需要在有新消息时通过多种方式吸引用户注意力。所有行为均由 **Web 端驱动**（Web 端检测到新消息 → 调用 Tauri API），壳子提供原生能力支撑。

### 8.1 新消息提醒的三层机制

收到新消息且窗口不在前台时，依次触发：

| 层级 | 机制 | Windows | macOS | 实现方式 |
|---|---|---|---|---|
| 1 | **系统通知** | Toast 通知（Action Center） | 通知中心通知 | `tauri-plugin-notification`，已在能力预埋中包含 |
| 2 | **任务栏/Dock 闪烁** | 任务栏按钮橙色闪烁 | Dock 图标弹跳 | `Window.requestUserAttention()` |
| 3 | **托盘图标状态变化** | 图标切换为"有消息"样式 | 同左 | `TrayIcon.setIcon()` + `setTooltip()` |

用户点击通知或窗口获焦后，停止所有提醒状态。

### 8.2 托盘图标闪动（新消息指示）

**实现方案**：定时器交替切换图标（标准 → 高亮/有消息 → 标准 → ...），而非真正的动画。

```
Web 端新消息到达
  │
  ├─ tray.setIcon('tray-icon-unread.png')     // 切换为"有消息"图标
  ├─ setInterval(() => {                       // 可选：闪动效果
  │    toggle between normal/unread icon
  │  }, 500ms)
  ├─ tray.setTooltip('CoClaw - 3 条未读消息')  // 更新 tooltip
  └─ window.requestUserAttention('Informational') // 任务栏闪烁

用户恢复窗口焦点
  │
  ├─ tray.setIcon('tray-icon.png')             // 恢复正常图标
  ├─ clearInterval(...)                         // 停止闪动
  └─ tray.setTooltip('CoClaw')                 // 恢复默认 tooltip
```

**所需图标资源**：
- `tray-icon.png` — 正常状态
- `tray-icon-unread.png` — 有未读消息状态（如带红点或高亮的变体）
- macOS 需对应的 template image 版本

**已知限制**：
- macOS 上 `setIcon()` 后需重新调用 `setIconAsTemplate(true)`，否则暗色模式下图标颜色异常（tauri#6527）
- Windows `requestUserAttention(Informational)` 可能仅闪烁约 3 次后停止（tauri#8658），而非持续闪烁至获焦。`Critical` 类型会持续闪烁，但视觉效果更强烈

**关于"忽略/dismiss"操作**：Windows 系统托盘没有原生的 hover preview + dismiss 按钮机制。主流 IM（微信、Telegram）也不实现此功能。用户通过点击系统通知的关闭按钮或点击窗口获焦来隐式"忽略"提醒。

### 8.3 任务栏/Dock 闪烁

```js
// Web 端触发
const win = window.__TAURI__.window.getCurrentWindow();

// 新消息到达且窗口不在前台
await win.requestUserAttention(
    window.__TAURI__.window.UserAttentionType.Informational
);

// 窗口获焦后停止
await win.requestUserAttention(null);
```

| 平台 | 行为 |
|---|---|
| Windows | 任务栏按钮橙色闪烁（`FlashWindowEx`） |
| macOS | Dock 图标弹跳一次（`Informational`）或持续弹跳（`Critical`） |

### 8.4 应用图标未读数字徽章

三端均预埋此能力，Web 端维护统一的未读计数状态。

#### 各平台实现方式

| 平台 | 机制 | API | 效果 | 状态 |
|---|---|---|---|---|
| **Windows** | 任务栏叠加图标 | Rust 自定义 command（JS API 不支持） | 任务栏按钮右下角显示 16×16 小图标 | TODO |
| **macOS** | Dock 原生徽章 | Rust 自定义 command（JS API 不支持） | Dock 图标右下角红色数字圆圈 | TODO |
| **Android** | 启动器通知徽章 | `@capawesome/capacitor-badge` | 效果因启动器而异（原生小红点或数字） | TODO |

> **注**：设计文档初版中使用的 `Window.setOverlayIcon()` 和 `Window.setBadgeCount()` 在 Tauri v2 的 JS Window API 中不存在。需通过 Rust 端自定义 `tauri::command` 调用底层 API 实现，Web 端通过 `invoke()` 调用。

#### Windows 叠加图标的特殊处理

Windows 没有原生的数字徽章 API，需自行将数字渲染为 16×16 图片：

```js
// Web 端渲染未读数字为图片
function renderBadgeIcon(count) {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    // 红色圆形背景
    ctx.fillStyle = '#FF3B30';
    ctx.beginPath();
    ctx.arc(8, 8, 8, 0, Math.PI * 2);
    ctx.fill();
    // 白色数字
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 99 ? '99+' : String(count), 8, 9);
    return canvas.toDataURL();
}

const win = window.__TAURI__.window.getCurrentWindow();
await win.setOverlayIcon(renderBadgeIcon(unreadCount));
// 清除徽章
await win.setOverlayIcon(null);
```

#### macOS Dock 徽章

```js
const win = window.__TAURI__.window.getCurrentWindow();
await win.setBadgeCount(unreadCount);
// 清除
await win.setBadgeCount(null);
```

#### Android 徽章（需补充预埋）

当前 APK 未实现此功能。需要：
1. 安装 `@capawesome/capacitor-badge` 插件（基于 ShortcutBadger，支持 30+ 启动器）
2. Web 端统一调用：`Badge.set({ count: unreadCount })`
3. **注意**：不是所有 Android 启动器都支持数字徽章，部分仅显示小红点

> **TODO**：在 `ui/android` 中补充 `@capawesome/capacitor-badge` 依赖，纳入 APK 壳子的下一次预埋更新。

#### Web 端未读计数状态

当前前端 store 中 **尚无未读计数追踪**。需后续在 `sessions.store.js` 或新建 `notification.store.js` 中添加：
- 按 session 的未读消息计数
- 全局未读总数
- 根据当前平台调用对应的徽章 API

此为 Web 端功能开发，不影响壳子预埋。

### 8.5 能力预埋要点

以上所有 IM 通知特性所需的壳子能力已在第 6 节 capabilities 中覆盖：

| 特性 | 依赖的 capability |
|---|---|
| 系统通知 | `notification:default` |
| 任务栏闪烁 | `core:window:default`（含 `requestUserAttention`） |
| 托盘图标切换 | 内置（tray-icon feature） |
| 托盘 tooltip | 内置 |
| 叠加图标/徽章 | `core:window:default`（含 `setOverlayIcon`、`setBadgeCount`） |

无需新增额外 capability。

## 9. 平台检测与前端适配

### 9.1 统一平台检测

当前前端通过 `Capacitor.isNativePlatform()` 检测是否在原生壳子中。已扩展以支持 Tauri。

**实现**：`src/utils/platform.js`

```js
// 注意：此模块不依赖 capacitor-app.js，避免 Tauri/Web 环境加载 @capacitor/core
// 通过 window.Capacitor 运行时对象检测，与 media-helper.js、voice-recorder.js 的方式一致

/** 是否运行在桌面壳子（Tauri）中 */
export const isTauriApp = '__TAURI_INTERNALS__' in window;

/** 是否运行在移动壳子（Capacitor）中 */
export const isCapacitorApp = !!window.Capacitor?.isNativePlatform();

/** 是否运行在任何原生壳子中（Capacitor 或 Tauri） */
export const isNativeShell = isCapacitorApp || isTauriApp;

/** 是否为桌面环境（Tauri 或普通浏览器桌面视口） */
export const isDesktop = isTauriApp || !isCapacitorApp;

/** 平台标识 */
export function getPlatformType() { ... }
```

> **设计决策**：`platform.js` 不 `import` 任何 Capacitor 包，而是通过 `window.Capacitor` 全局对象检测。这确保在 Tauri 和普通 Web 环境下不会触发 `@capacitor/core` 的加载。`capacitor-app.js` 仅由 `main.js`（初始化）和 `theme-mode.js`（状态栏同步）导入，这两个场景在非 Capacitor 环境下通过内部 guard 直接跳过。

### 9.2 `isNative` 引用迁移（已完成）

已将视图层中所有 `isNative`（来自 `capacitor-app.js`）引用替换为 `isCapacitorApp`（来自 `platform.js`）：

| 使用位置 | 用途 | 迁移结果 |
|---|---|---|
| `AuthedLayout.vue` rootClasses/innerClasses/sectionClasses | 移动端视口约束、safe-area | ✅ 改用 `isCapacitorApp`，Tauri 桌面走 Web 布局 |
| `ChatPage.vue` chatRootClasses | 移动端 flex 布局 | ✅ 改用 `isCapacitorApp` |
| `ChatPage.test.js` | 测试 mock | ✅ 改为 mock `platform.js` |
| `voice-recorder.js` | enumerateDevices 可靠性判断 | ✅ 局部变量重命名为 `isCapacitor`（使用 `window.Capacitor` 检测） |
| `media-helper.js` | 跳过 permissions.query | 保持原样（已使用 `window.Capacitor` 检测） |
| `capacitor-app.js` | StatusBar / BackButton 初始化 | 保持原样（内部 `isNative` guard，非 Capacitor 环境直接跳过） |

**核心原则**：现有 `isNative` 的所有使用场景都是为了规避 Capacitor WebView 的限制或适配移动端 UI，Tauri 桌面端不需要这些适配。视图层统一从 `platform.js` 导入，不直接依赖 `@capacitor/core`。

### 9.3 Tauri 壳子专属初始化（已实现）

**实现**：`src/utils/tauri-app.js`

- 入口 `initTauriApp(router)`，非 Tauri 环境直接跳过
- Deep Link 监听：解析 `coclaw://` URL，拼接 `host + pathname` 为 Vue 路由路径并导航
- 在 `main.js` 中，`initCapacitorApp(router)` 之后调用 `initTauriApp(router)`
- 窗口关闭行为（隐藏到托盘）在 Rust 端 `tray.rs` 处理

**另有**：`src/utils/tauri-notify.js` 封装了 Tauri 桌面端 IM 通知能力（系统通知、任务栏闪烁、托盘 tooltip），所有方法在非 Tauri 环境静默跳过。

> TODO：任务栏叠加图标（Windows overlay icon）/ Dock 徽章（macOS setBadgeCount）需通过 Rust 侧自定义 command 实现，Tauri v2 的 JS Window API 当前不支持这些方法。

## 10. Tauri 插件清单

### 10.1 Rust 依赖（Cargo.toml）

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-notification = "2"
tauri-plugin-shell = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-updater = "2"
tauri-plugin-os = "2"
tauri-plugin-store = "2"
tauri-plugin-window-state = "2"
tauri-plugin-process = "2"
tauri-plugin-http = "2"
tauri-plugin-log = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 10.2 插件注册（lib.rs）

> 注意：部分插件使用 `init()` 初始化，部分使用 `Builder` 模式。以实际代码 `src-tauri/src/lib.rs` 为准。

```rust
// src/lib.rs（简化示意，完整代码见源文件）
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())   // Builder 模式
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())     // Builder 模式
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build()) // Builder 模式
        .setup(|app| { tray::init(app)?; Ok(()) })
        .on_window_event(|window, event| {
            tray::handle_window_event(window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running CoClaw");
}
```

### 10.3 与 Android Capacitor 插件对照

| 用途 | Capacitor 插件 | Tauri 插件 | 备注 |
|---|---|---|---|
| 文件系统 | `@capacitor/filesystem` | `tauri-plugin-fs` + `tauri-plugin-dialog` | dialog 用于文件选择 |
| 剪贴板 | `@capacitor/clipboard` | `tauri-plugin-clipboard-manager` | 桌面端支持图片剪贴板 |
| 通知 | `@capacitor/local-notifications` | `tauri-plugin-notification` | 系统通知 |
| 外部链接 | `@capacitor/browser` | `tauri-plugin-shell` (open) | 用系统默认浏览器打开 |
| 摄像头 | `@capacitor/camera` | WebView 原生 API | 无需额外插件 |
| 网络状态 | `@capacitor/network` | `navigator.onLine` + 事件 | Web API 即可 |
| 键盘 | `@capacitor/keyboard` | 不适用 | 桌面端无虚拟键盘 |
| 触觉 | `@capacitor/haptics` | 不适用 | 桌面无震动 |
| 启动屏 | `@capacitor/splash-screen` | 不适用 | 桌面无启动屏 |
| 分享 | `@capacitor/share` | 无直接对等 | 可用 clipboard 替代 |
| 返回键 | `@capacitor/app` | 不适用 | 桌面无硬件返回键 |
| 状态栏 | `@capacitor/status-bar` | 不适用 | 桌面无状态栏 |
| 后台保活 | KeepAliveService (自研) | 系统托盘 (Tauri 内置) | 实现机制不同 |
| Deep Link | Intent Filter | `tauri-plugin-deep-link` | 协议一致 |
| 自动更新 | 无（Web 远程加载） | `tauri-plugin-updater` | 壳子自更新 |
| 窗口状态 | 不适用 | `tauri-plugin-window-state` | 桌面专属 |
| 持久存储 | 不适用 | `tauri-plugin-store` | 用户偏好 |

## 11. macOS 专属配置

### 11.1 Entitlements.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- JIT（WKWebView 必需，否则 notarization 后崩溃） -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>

    <!-- 麦克风 -->
    <key>com.apple.security.device.audio-input</key>
    <true/>

    <!-- 摄像头 -->
    <key>com.apple.security.device.camera</key>
    <true/>

    <!-- 网络（出站连接） -->
    <key>com.apple.security.network.client</key>
    <true/>

    <!-- App Sandbox（Mac App Store 必需） -->
    <key>com.apple.security.app-sandbox</key>
    <true/>

    <!-- 用户选择的文件访问（通过 Open/Save 对话框） -->
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>

    <!-- 下载目录读写 -->
    <key>com.apple.security.files.downloads.read-write</key>
    <true/>
</dict>
</plist>
```

### 11.2 Info.plist 补充条目

通过 `tauri.conf.json` 的 `bundle.macOS.infoPlist` 或独立文件注入：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSMicrophoneUsageDescription</key>
    <string>CoClaw 需要使用麦克风来录制语音消息</string>

    <key>NSCameraUsageDescription</key>
    <string>CoClaw 需要使用摄像头来拍摄照片和视频</string>
</dict>
</plist>
```

### 11.3 macOS 窗口行为

- 标题栏：`overlay` 模式（隐藏标题文字，保留红绿灯按钮）
- 全屏：支持（WKWebView 原生全屏）
- Dock 图标：始终显示（即使最小化到托盘），用户可点击 dock 恢复窗口
- 托盘图标：使用 template image，自动适配深/浅色模式

## 12. 构建与分发

### 12.0 交叉编译说明

Tauri 基于 Rust 原生编译，**不支持可靠的跨 OS 交叉编译**：

- Windows 安装包必须在 **Windows** 上构建
- macOS 安装包必须在 **macOS** 上构建
- WSL2 (Linux) 仅能构建 Linux 版本，不能产出 `.exe` 或 `.dmg`

> Tauri 官方文档虽提及通过 `cargo-xwin` 从 Linux 交叉编译 Windows 的路径，但明确标注为"最后手段"，存在未解决的 bug（tauri#13829、tauri#9598），且不支持代码签名。不推荐用于生产构建。
>
> 对比：Electron 因打包预编译的 Chromium + JS，支持从 Linux 交叉编译 Windows/macOS。Tauri 的架构决定了这一限制。

**推荐构建方式**：
- 本地开发/验证：在对应 OS 的物理机上构建
- 持续集成：GitHub Actions 使用 `windows-latest` / `macos-latest` runner

### 12.1 构建命令（package.json scripts）

所有构建命令均需在**目标 OS** 上执行：

```bash
# ---- Windows（在 Windows 上执行）----
pnpm tauri:build:win                      # NSIS 安装包（官网直接下载分发）

# ---- macOS（在 macOS 上执行）----
pnpm tauri:build:mac                      # Universal Binary DMG（官网直接下载）
pnpm tauri:build:mac-app                  # Universal Binary .app（用于 App Store 打包）

# ---- 通用 ----
pnpm tauri:dev                            # 开发模式（本地前端 + Tauri 窗口）
pnpm tauri:build                          # 默认构建（自动检测当前 OS）
```

| 脚本 | 实际命令 | 目标 OS |
|---|---|---|
| `tauri:build:win` | `tauri build --bundles nsis` | Windows |
| `tauri:build:mac` | `tauri build --target universal-apple-darwin --bundles dmg` | macOS |
| `tauri:build:mac-app` | `tauri build --target universal-apple-darwin --bundles app` | macOS |

### 12.1.1 签名密钥管理

所有平台的签名密钥统一存放于开发者 home 目录 `~/.coclaw/keys/`，**不入库**：

```
~/.coclaw/keys/
├── android-release.jks       # Android APK 签名密钥库
├── tauri-updater.key         # Tauri 自动更新签名私钥
└── tauri-updater.key.pub     # Tauri 自动更新签名公钥
```

| 密钥 | 格式 | 用途 | 生成方式 |
|---|---|---|---|
| `android-release.jks` | Java KeyStore (RSA) | Android APK 发布签名 | `keytool -genkey ...` |
| `tauri-updater.key` | Ed25519 (minisign) | Tauri 壳子更新包签名 | `pnpm tauri signer generate` |

**新开发者配置**：从团队密码管理器获取密钥文件，放入 `~/.coclaw/keys/` 即可。无需修改任何项目配置。

**构建时如何读取**：

- **Android**：`build.gradle` 默认读取 `~/.coclaw/keys/android-release.jks`，密码通过 `android/local.properties` 配置。可通过 `COCLAW_STORE_FILE` 覆盖路径
- **Tauri**：构建脚本 `scripts/tauri-build.sh`（Bash）/ `scripts/tauri-build.ps1`（PowerShell）自动从 `~/.coclaw/keys/tauri-updater.key` 读取并设置 `TAURI_SIGNING_PRIVATE_KEY` 环境变量
- **CI**：通过 GitHub Actions secrets 注入环境变量，不依赖文件

### 12.1.2 Windows 一键构建步骤

**前置环境（一次性搭建）：**

```powershell
# 1. 安装 Rust
winget install Rustlang.Rustup
# 或访问 https://rustup.rs 下载安装

# 2. 安装 Visual Studio Build Tools 2022+（勾选"使用 C++ 的桌面开发"）
winget install Microsoft.VisualStudio.2022.BuildTools

# 3. 安装 Node.js 20+
winget install OpenJS.NodeJS.LTS

# 4. 启用 pnpm
corepack enable

# 5. WebView2 Runtime（Win10/11 通常已预装，若未安装）
# https://developer.microsoft.com/en-us/microsoft-edge/webview2/

# 6. 放置签名密钥（从团队密码管理器获取）
mkdir $HOME\.coclaw\keys
# 将 tauri-updater.key 放入该目录
```

**构建：**

```powershell
cd path\to\coclaw\ui
pnpm install
.\scripts\tauri-build.ps1 --bundles nsis     # 自动加载签名密钥
```

产出位置：`src-tauri\target\release\bundle\nsis\coclaw_{version}_x64-setup.exe`

### 12.1.3 macOS 一键构建步骤

**前置环境（一次性搭建）：**

```bash
# 1. 安装 Xcode Command Line Tools
xcode-select --install

# 2. 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3. 添加 Universal Binary 所需的两个 target
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 4. 安装 Node.js 20+（通过 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22

# 5. 启用 pnpm
corepack enable

# 6. 放置签名密钥
mkdir -p ~/.coclaw/keys
# 将 tauri-updater.key 放入该目录
```

**构建：**

```bash
cd path/to/coclaw/ui
pnpm install
./scripts/tauri-build.sh --target universal-apple-darwin --bundles dmg     # DMG
# 或
./scripts/tauri-build.sh --target universal-apple-darwin --bundles app     # App Store
```

产出位置：`src-tauri/target/universal-apple-darwin/release/bundle/dmg/CoClaw_{version}_universal.dmg`

### 12.2 安装包输出

| 平台 | 格式 | 用途 | 大致体积 |
|---|---|---|---|
| Windows | `coclaw-{version}-setup.exe` (NSIS) | 官网直接下载 | ~5-8 MB |
| Windows | MSIX (via winapp CLI) | Microsoft Store | ~5-8 MB + 签名 |
| macOS | `CoClaw-{version}.dmg` | 官网直接下载 | ~8-12 MB |
| macOS | `CoClaw-{version}.pkg` | Mac App Store | ~8-12 MB |

### 12.3 Microsoft Store 发布流程

采用 **winapp CLI + MSIX** 路径（商店自动签名，无需自购 Windows 代码签名证书）：

```bash
# 1. 初始化（仅首次）
winapp init

# 2. 构建 Tauri 应用
pnpm tauri build

# 3. 生成调试身份
winapp create-debug-identity

# 4. 打包 MSIX
winapp pack

# 5. 提交到商店
winapp store publish ./coclaw.msix --appId <app-id>
```

**商店账号信息**：
- 发布主体：成都共演科技有限公司（Chengdu Gongyan Technology Co., Ltd.）
- 账号类型：公司（$99 一次性）

### 12.4 Mac App Store 发布流程

```bash
# 1. 构建 Universal Binary
pnpm tauri build --target universal-apple-darwin --bundles app

# 2. 签名（自动，需配置环境变量）
# APPLE_SIGNING_IDENTITY, APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH

# 3. 打包为 .pkg
productbuild --component target/universal-apple-darwin/release/bundle/macos/CoClaw.app \
  /Applications CoClaw.pkg --sign "3rd Party Mac Developer Installer: ..."

# 4. 上传到 App Store Connect
xcrun altool --upload-app -f CoClaw.pkg --type macos
```

**Apple Developer 账号信息**：
- 发布主体：成都共演科技有限公司
- 账号类型：组织（$99/年，需 D-U-N-S 编号）

### 12.5 代码签名策略

| 平台 | 分发渠道 | 签名方式 |
|---|---|---|
| Windows | Microsoft Store (MSIX) | 商店自动签名（无需自购证书） |
| Windows | 官网直接下载 (NSIS) | OV 证书（初期）→ 积累信誉后 SmartScreen 信任 |
| macOS | Mac App Store | Apple Distribution 证书 |
| macOS | 官网直接下载 (DMG) | Developer ID Application + 公证 (Notarization) |

### 12.6 壳子版本升级策略

桌面壳子与 Android APK 采用统一的升级策略：**Web 端主导检测，壳子不内置更新逻辑**。

#### 两层更新机制

| 层级 | 更新方式 | 频率 |
|---|---|---|
| Web 内容 | 远程加载 `im.coclaw.net`，自动生效 | 每次部署即生效 |
| 壳子本身 | Tauri updater（自动更新） + Web 端版本检测（兜底） | 极少（仅权限/插件变更时） |

#### Web 端版本检测（与 Android 一致）

```
App 启动 → 加载 im.coclaw.net
  → Web 端通过 Tauri API 获取当前壳子版本
  → 与服务端下发的 minRequiredVersion 对比
  → 若低于最低版本 → 显示阻断式更新引导
  → 引导用户到 Microsoft Store / Mac App Store 更新（或提供直接下载链接）
```

此方案适用于所有分发渠道（商店 + 官网直接下载），不依赖特定平台 API。

#### Tauri updater（壳子自动更新，仅直接下载版）

通过 Microsoft Store / Mac App Store 分发的版本由商店自动管理更新。Tauri updater 仅用于**官网直接下载版**的自动更新：

```
用户端                                    GitHub Releases
  │                                           │
  ├─ check()  ──────────────────────────────► │
  │  GET /latest/download/latest.json         │
  │                                           │
  ◄──────────────────── 200 + JSON ───────────┤ (有更新)
  │  { version, url, signature, notes }       │
  │                                           │
  ├─ downloadAndInstall() ──────────────────► │
  │  下载签名验证后的安装包                      │
  │                                           │
  ├─ relaunch() ──► 重启应用                    │
```

**更新签名密钥管理**：
- 首次执行 `pnpm tauri signer generate` 生成公私钥对
- 私钥存入密码管理器（丢失后无法发布更新）
- 公钥配置在 `tauri.conf.json` → `plugins.updater.pubkey`
- CI 构建时通过环境变量 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 传入私钥

## 13. 应用图标

### 13.1 所需图标列表

Tauri CLI 提供 `pnpm tauri icon <source-image>` 命令，从一张 1024×1024 PNG 自动生成所有尺寸：

| 文件 | 用途 |
|---|---|
| `icon.ico` | Windows 应用图标 |
| `icon.icns` | macOS 应用图标 |
| `icon.png` | 通用（1024×1024） |
| `32x32.png` | 小图标 |
| `128x128.png` | 中图标 |
| `128x128@2x.png` | Retina 中图标 |
| `Square150x150Logo.png` | Windows Store 磁贴 |
| `tray-icon.png` | 系统托盘（见 7.5 规格） |

### 13.2 IM 通知相关图标

| 文件 | 用途 | 规格 |
|---|---|---|
| `tray-icon-unread.png` | 托盘"有未读消息"状态图标 | 同 tray-icon 尺寸，带红点或高亮变体 |
| `tray-icon-unread-template.png` | macOS 未读状态 template image | 单色（黑+透明），44×44 px |

### 13.3 图标来源

使用与 Android APK 相同的应用图标。托盘图标需额外制作：
- 正常状态单色版（macOS template image 要求）
- 未读消息状态变体（正常 + macOS template 各一份）

## 14. 已知风险与缓解

### 14.1 macOS WKWebView 麦克风/摄像头权限问题

**风险**：wry#1195 — `getUserMedia()` 权限弹窗行为不一致
**影响**：语音录制功能可能在 macOS 上首次使用时无法正常弹出权限请求
**缓解**：
1. 确保 `Info.plist` 和 `Entitlements.plist` 声明完整
2. 实际测试确认行为
3. 若不弹窗，使用 `tauri-plugin-macos-permissions` 在 Rust 端主动请求权限
4. 持续关注 wry#1195 修复进度，修复后移除 workaround

### 14.2 macOS App Sandbox 网络限制

**风险**：tauri#13878 — 沙箱模式下部分出站网络请求被静默阻断
**影响**：远程加载 `im.coclaw.net` 和 WebSocket 连接可能受阻
**缓解**：
1. 确保 `Entitlements.plist` 包含 `com.apple.security.network.client`
2. 测试 WebSocket 连接（bot-connection.js）在沙箱模式下是否正常
3. 若仍有问题，考虑使用 `tauri-plugin-http` / `tauri-plugin-websocket` 作为 Rust 代理绕过

### 14.3 Windows SmartScreen 警告

**风险**：使用 OV 证书签名的安装包，初期会被 SmartScreen 标记为"未知发布者"
**影响**：部分用户可能因警告放弃安装
**缓解**：
1. Microsoft Store 版本不受影响（商店签名自带信任）
2. 引导用户优先从 Microsoft Store 安装
3. OV 证书积累一定下载量后信誉自动提升
4. 预算允许时升级 EV 证书

### 14.4 Tauri 远程加载模式的 CSP 限制

**风险**：Tauri 的 CSP 策略可能与远程加载的 Web 应用冲突
**缓解**：
1. 不在 `tauri.conf.json` 中配置 CSP（让远程服务器的 CSP 头生效）
2. 依赖 capability 的 `remote.urls` 限制 IPC 访问范围
3. 仅允许 `*.coclaw.net` 域名访问 Tauri 命令

### 14.5 `withGlobalTauri` 安全性

**风险**：开启 `withGlobalTauri` 后，`window.__TAURI__` 暴露给所有加载的页面
**缓解**：
1. capability 的 `remote.urls` 限制了只有 `*.coclaw.net` 能调用 IPC
2. 主窗口仅加载 `im.coclaw.net`，不会加载第三方页面
3. 外部链接通过 `shell:allow-open` 在系统浏览器中打开，不在 WebView 内加载

## 15. 开发环境要求

### 15.1 Windows 开发环境

| 依赖 | 版本 | 安装方式 |
|---|---|---|
| Rust | stable (latest) | `rustup` |
| Visual Studio Build Tools | 2022+ | `winget` 或 VS Installer |
| WebView2 Runtime | 最新 | Win10/11 一般已预装 |
| Node.js | 20+ | `nvm-windows` |
| pnpm | 9+ | `corepack enable` |
| Tauri CLI | 2.x | `pnpm add -D @tauri-apps/cli` |
| winapp CLI | latest | `winget install Microsoft.WinAppCli`（商店发布用） |

### 15.2 macOS 开发环境

| 依赖 | 版本 | 安装方式 |
|---|---|---|
| Rust | stable (latest) | `rustup` |
| Xcode | 15+ | App Store |
| Xcode Command Line Tools | 对应版本 | `xcode-select --install` |
| Node.js | 20+ | `nvm` |
| pnpm | 9+ | `corepack enable` |
| Tauri CLI | 2.x | `pnpm add -D @tauri-apps/cli` |
| Rust targets | aarch64 + x86_64 | `rustup target add` |

### 15.3 构建环境约束

Tauri 不支持可靠的跨 OS 交叉编译（详见 §12.0），各平台构建必须在对应 OS 上执行：

| 操作 | WSL2 (Linux) | Windows 宿主机 | macOS |
|---|---|---|---|
| 前端开发 (`pnpm dev`) | ✅ | ✅ | ✅ |
| Rust 编译检查 (`cargo check`) | ✅ | ✅ | ✅ |
| 单元测试 (`pnpm test`) | ✅ | ✅ | ✅ |
| Tauri 开发模式 (`pnpm tauri:dev`) | ❌ 无图形界面 | ✅ | ✅ |
| 构建 Windows 安装包 (`pnpm tauri:build:win`) | ❌ | ✅ | ❌ |
| 构建 macOS DMG (`pnpm tauri:build:mac`) | ❌ | ❌ | ✅ |

**当前日常开发流程**：WSL2 负责前端代码编写、Rust 编译检查、测试；Windows 宿主机负责实际构建和调试。

## 16. 实施计划

### Phase 1：Windows 壳子开发（当前）

1. **项目初始化** ✅
   - 在 `ui/` 下执行 `pnpm tauri init` 生成 `src-tauri/` 骨架
   - 配置 `tauri.conf.json`（远程加载、窗口参数、图标）
   - 安装所有 Tauri 插件（Cargo.toml）
   - 准备图标资源（应用图标 + 托盘图标 + 托盘未读图标）

2. **核心功能实现** ✅
   - 系统托盘（tray.rs）：托盘图标、菜单、关闭行为、tooltip
   - Deep Link 监听（`coclaw://` 协议）
   - 窗口状态保存/恢复（`tauri-plugin-window-state`）
   - WebView2 麦克风/摄像头权限自动批准（Rust 端 `PermissionRequested` 处理）— TODO：待 Windows 构建验证时确认

3. **能力预埋** ✅
   - 编写 `capabilities/main.json` 声明所有权限
   - 注册全部插件（lib.rs）

4. **前端适配** ✅
   - 新建 `src/utils/platform.js` 统一平台检测
   - 迁移现有 `isNative` 引用为 `isCapacitorApp`
   - 新建 `src/utils/tauri-app.js` 桌面壳子初始化
   - 在 Web 设置页面中添加壳子设置项（仅 Tauri 环境显示）— TODO：待壳子设置需求明确后添加

5. **IM 通知特性**（进行中）
   - 实现托盘图标闪动（新消息时切换图标）
   - 实现任务栏闪烁（`requestUserAttention`）
   - 实现任务栏叠加图标（未读数字渲染）
   - 集成 `tauri-plugin-notification` 系统通知
   - 托盘 tooltip 动态更新

6. **构建验证**（需 Windows 宿主机）
   - Windows 宿主机构建 NSIS 安装包
   - 安装并测试核心功能：远程加载、托盘、语音录制、剪贴板、通知、图标闪动

7. **自动更新**
   - 生成签名密钥对
   - 配置 updater endpoint（GitHub Releases）

### Phase 2：Microsoft Store 上架

1. 注册公司开发者账号
2. winapp CLI 生成 MSIX
3. 准备商店素材（截图、描述、隐私政策 URL）
4. 提交审核

### Phase 3：macOS 壳子开发（TODO — 待环境就绪后启动）

> **状态**：暂缓。当前无 macOS 开发环境。`Entitlements.plist`、`Info.plist`、`tauri.macos.conf.json` 已按设计文档预置于 `src-tauri/`，待 macOS 环境就绪后直接进入测试验证阶段。

1. macOS 开发环境搭建（Rust + Xcode + targets）
2. 验证已预置的 `Entitlements.plist`、`Info.plist` 配置
3. 测试 WKWebView 兼容性（尤其是麦克风/摄像头权限，关注 wry#1195）
4. 测试 App Sandbox 下的网络连接（WebSocket、SSE）
5. 验证 Dock 徽章（`setBadgeCount`）和 Dock 弹跳
6. 验证托盘 template image 在深/浅色模式下的表现
7. 构建 Universal Binary DMG
8. 申请 Apple Developer 组织账号（需 D-U-N-S 编号）
9. Mac App Store 上架

### Phase 4：CI/CD 集成（后续）

- GitHub Actions 自动构建 Windows/macOS 安装包
- 自动生成 `latest.json` 更新清单
- Release tag 触发构建与发布

## 17. 商店上架前置清单

与 Android 上架清单（`android-release-config.md` TODO 章节）保持一致：

- [ ] **隐私政策页面**（三端共用同一 URL）
- [ ] **用户服务协议页面**（三端共用同一 URL）
- [ ] **应用截图**：Windows 桌面端、macOS 桌面端各需一套
- [ ] **应用简介**：中/英文
- [ ] **年龄分级问卷**：Microsoft Store (IARC) / Mac App Store (Apple 自有)
- [ ] **应用分类**
- [ ] Microsoft Store 公司开发者账号注册（$99 一次性）
- [ ] Apple Developer 组织账号注册（$99/年，需 D-U-N-S）
- [ ] Windows OV 代码签名证书采购（官网直接下载版）
- [ ] macOS Apple Distribution 证书 + Developer ID 证书
- [ ] Tauri updater 签名密钥对生成与备份

## 18. package.json 变更

在 `ui/package.json` 中新增：

```jsonc
{
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  },
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "tauri:icon": "tauri icon"
  }
}
```

前端代码不需要安装 `@tauri-apps/api` 包——因为使用远程加载 + `withGlobalTauri: true` 模式，Tauri API 通过 `window.__TAURI__` 全局对象访问。
