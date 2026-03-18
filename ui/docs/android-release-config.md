# Android Release 配置记录

> 首次配置时间：2026-03-10

## 配置结果

| 项目 | 状态 |
|------|------|
| Keystore | 默认 `~/.coclaw/keys/android-release.jks`；可通过 `local.properties` 的 `COCLAW_STORE_FILE` 覆盖 |
| 签名配置 | `build.gradle` 从 `local.properties` 读取密码和可选路径覆盖（不入库） |
| 签名格式 | PKCS12（keytool 默认），keystore 和 key 共用同一密码 |
| versionName | `1.0.0` |
| versionCode | `1` |
| applicationId | `net.coclaw.im` |
| allowBackup | `false` |
| minifyEnabled | `false`（Capacitor 壳层代码极少，无需混淆） |
| 权限 | INTERNET, CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, READ_MEDIA_IMAGES, READ/WRITE_EXTERNAL_STORAGE（≤Android 12） |
| Release APK | 构建成功，约 6.1MB |

## 签名指纹（备案用）

- **SHA1**: `3B:E2:8A:17:48:4E:97:D4:DA:21:39:C6:25:B3:36:10:D0:66:FC:C1`
- **SHA256**: `DA:02:39:18:B5:DA:36:39:03:C0:CD:05:5D:AE:6C:17:D4:B6:7B:FD:35:0D:AC:E3:F8:64:CD:21:DC:6F:2E:DA`
- **MD5**: `56:C5:1E:DC:C3:B4:73:04:CF:14:9F:A2:52:92:3B:73`

## 发布主体

成都共演科技有限公司（Chengdu Gongyan Technology Co., Ltd.）

## 密码

Keystore 密码：`xxx`（keystore 和 key 共用）

> 此密码应妥善保管于密码管理器中，丢失后无法恢复 keystore 访问权限。

## APK 构建命令

```bash
cd ui/android && ./gradlew assembleRelease
```

产出路径：`android/app/build/outputs/apk/release/coclaw-<version>.apk`（如 `coclaw-1.0.0.apk`）

## 壳子能力预埋（2026-03-12）

目标：一次性将 APK 壳子所需的所有原生能力（权限、插件、Manifest 配置、原生代码）预埋完毕，后续仅通过 Web 端更新即可启用功能，无需重新发布 APK。

### 追加权限

| 权限 | 用途 |
|------|------|
| `POST_NOTIFICATIONS` | Android 13+ 通知权限 |
| `FOREGROUND_SERVICE` | 后台保活（切后台不被杀） |
| `FOREGROUND_SERVICE_DATA_SYNC` | Android 14+ 前台服务类型声明 |
| `WAKE_LOCK` | 防止 CPU 休眠断连 |
| `VIBRATE` | 通知震动 |
| `ACCESS_NETWORK_STATE` | 网络状态检测，驱动重连 |
| `READ_MEDIA_VIDEO` | Android 13+ 细粒度媒体权限 |
| `READ_MEDIA_AUDIO` | Android 13+ 细粒度媒体权限 |
| `MODIFY_AUDIO_SETTINGS` | Capacitor WebView 麦克风权限流程所需（详见踩坑记录） |

### 安装 Capacitor 插件

| 插件 | 用途 |
|------|------|
| `@capacitor/local-notifications` | 本地通知 |
| `@capacitor/clipboard` | 剪贴板读写（代码复制等） |
| `@capacitor/share` | 分享内容到其他 App |
| `@capacitor/filesystem` | 文件读写（Artifacts 下载等） |
| `@capacitor/camera` | 拍照（权限已有，补插件桥接） |
| `@capacitor/network` | 网络状态监听 |
| `@capacitor/keyboard` | 键盘事件处理（聊天输入） |
| `@capacitor/splash-screen` | 启动屏控制 |
| `@capacitor/haptics` | 触觉反馈 |
| `@capacitor/browser` | 应用内打开外部链接 |
| `@capawesome/capacitor-badge` | 启动器图标未读数字徽章（基于 ShortcutBadger，支持 30+ 启动器） |

### Manifest 配置

- **Share Target**：intent-filter 接收外部 App 分享的文本、图片、文件
- **Deep Link**：自定义 URL Scheme `coclaw://`
- **前台服务声明**：`KeepAliveService`（dataSync 类型）

### 原生代码

- `KeepAliveService.java`：前台服务，App 切后台时保持进程存活
- `MainActivity.java`：注册 KeepAliveService 插件

### 暂缓项（TODO）

- [ ] Firebase 项目 + `google-services.json` + `@capacitor/push-notifications`（FCM 推送）
- [ ] `im.coclaw.net/.well-known/assetlinks.json`（HTTPS App Links 验证）
- [ ] `RECEIVE_BOOT_COMPLETED` + BootReceiver（开机自启服务，随 FCM 一起做）

## 壳子版本升级检测方案

APK 采用远程加载架构（`https://im.coclaw.net`），壳子极少需要更新（仅新增权限/插件/原生代码时）。升级检测由 **Web 端主导**，壳子不内置更新检测逻辑。

### 检测流程

```
App 启动 → 加载 im.coclaw.net
  → Web 端调用 @capacitor/app 的 App.getInfo() 获取当前 versionCode
  → 与服务端接口下发的 minRequiredVersion 对比
  → 若 versionCode < minRequiredVersion → 显示阻断式更新引导
  → 引导用户到对应商店更新（或提供直接下载链接）
```

### 依赖的已预埋能力

`@capacitor/app`（已安装，用于返回键处理）提供 `App.getInfo()` → `{ version, build }`，其中 `build` 即 Android `versionCode`。无需额外插件。

### 服务端接口（TODO）

需要在 server 端提供版本检查接口，例如：

```
GET /api/v1/app/version-check?platform=android&build=1
→ { "minRequired": 1, "latest": 2, "updateUrl": "https://..." }
```

### 适用范围

此方案适用于所有分发渠道（Google Play、国内商店、直接下载），无平台依赖。

### 备选：Google Play In-App Updates

若后续需要 Play 商店内无缝更新体验（后台下载 + 无跳转安装），可追加 `@capawesome/capacitor-app-update` 插件。当前不需要，因为：
1. 壳子更新频率极低
2. Web 端引导方案已覆盖所有渠道
3. 该插件仅适用于 Google Play，不覆盖国内商店

## TODO（上架应用商店前）

- [ ] 工信部 App 备案（签名指纹见上方）
- [ ] 隐私政策页面（需提供 URL）
- [ ] 用户服务协议页面（需提供 URL）
- [ ] App 首次启动隐私政策弹窗同意（前端开发）
- [ ] 应用商店素材：应用截图、简介、分类、目标用户年龄段
- [ ] 第三方 SDK 清单（国内商店合规要求）

## 踩坑记录

### Capacitor WebView 权限声明必须覆盖其内部请求的所有权限（2026-03-13）

**现象**：用户在原生弹窗中授权了麦克风权限，但 Web 端 `getUserMedia()` 仍报 `NotAllowedError`（"麦克风权限被拒绝"）。

**根因**：Capacitor 的 `BridgeWebChromeClient.onPermissionRequest()` 在处理 `AUDIO_CAPTURE` 时，会同时请求 `RECORD_AUDIO`（dangerous）和 `MODIFY_AUDIO_SETTINGS`（normal）两个权限，并以**全部通过**作为判定条件。如果 `MODIFY_AUDIO_SETTINGS` 未在 AndroidManifest.xml 中声明，系统直接返回 denied，导致整体判定失败，WebView 调用 `request.deny()`。

**修复**：在 AndroidManifest.xml 中补充 `MODIFY_AUDIO_SETTINGS` 声明。该权限为 normal 级别，安装时自动授予，不需要运行时弹窗。

**教训**：AndroidManifest.xml 中的权限声明不仅要覆盖业务直接使用的权限，还必须覆盖 Capacitor 框架内部隐式请求的权限。新增涉及原生能力的 Web API 调用时，应检查 Capacitor 对应的 `onPermissionRequest` / `onGeolocationPermissionsShowPrompt` 等回调中请求了哪些权限，确保 Manifest 全部声明。

**参考源码**：`node_modules/@capacitor/android/.../BridgeWebChromeClient.java` → `onPermissionRequest()` 方法。

### Edge-to-Edge 模式下 `env(safe-area-inset-top)` 在 Android 14 及以下为 0（2026-03-18）

**现象**：Redmi Note 12 5G（Android 14）上，ChatPage 内容覆盖到状态栏下方，顶部安全区域完全失效。开发者自用设备（K80-pro）无法复现。

**根因**：Capacitor 8 内置的 `SystemBars` 插件仅在 Android 15+（API 35）才向 WebView 注入 `--safe-area-inset-*` CSS 变量（`initSafeAreaInsets()` 和 `initWindowInsetsListener()` 有硬性 `>= VANILLA_ICE_CREAM` 门槛）。同时 `@capacitor/status-bar` 的 `setOverlaysWebView(true)` 使用的是已废弃的 `SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN` flag，Android 14 的 WebView 无法从该 flag 推断出正确的 safe area insets，导致 CSS `env(safe-area-inset-top)` 返回 0。

**修复**（三部分）：

1. **CSS 层**（`main.css`）：在 `:root` 中定义 `--safe-area-inset-top: env(safe-area-inset-top, 0px)` 和 `--safe-area-inset-bottom`，所有组件统一使用 `var(--safe-area-inset-top)` 而非直接裸用 `env()`
2. **JS 层**（`capacitor-app.js`）：`setupStatusBar()` 中调用 `StatusBar.getInfo()` 获取实际状态栏高度（dp），通过 `document.documentElement.style.setProperty()` 覆盖 CSS 变量
3. **Layout 层**（`AuthedLayout.vue`）：section 始终应用 `pt-[var(--safe-area-inset-top)]` 和 `pb-[var(--safe-area-inset-bottom)]`，统一管理安全区域，各子页面/组件不再各自处理

**教训**：不要假设 CSS `env(safe-area-inset-*)` 在所有 Android 版本上可靠工作。Edge-to-Edge 模式下，Capacitor 的 safe area 注入机制存在 API level 门槛。应始终通过 `StatusBar.getInfo()` 主动获取并注入 CSS 变量作为兜底。

**参考源码**：`node_modules/@capacitor/android/.../plugin/SystemBars.java` → `initSafeAreaInsets()`（第 160-172 行，`VANILLA_ICE_CREAM` 门控）。

### 软键盘遮挡输入区域（2026-03-18）

**现象**：部分设备上软键盘弹出后覆盖 ChatInput 输入框，用户无法看到输入内容。

**根因**：AndroidManifest.xml 未显式设置 `windowSoftInputMode`，系统默认 `adjustUnspecified` 在不同设备/ROM 上行为不一致。同时 `@capacitor/keyboard` 插件的 `resizeOnFullScreen` 默认为 `false`，在 Edge-to-Edge（fullscreen）模式下不执行任何 resize。

**修复**：

1. `AndroidManifest.xml`：Activity 添加 `android:windowSoftInputMode="adjustResize"`
2. `capacitor.config.ts`：添加 `plugins.Keyboard.resizeOnFullScreen: true`
3. `capacitor-app.js`：监听 `keyboardDidShow` 事件，对聚焦的 input/textarea 执行 `scrollIntoView` 作为兜底

**教训**：Edge-to-Edge 模式（`StatusBar.setOverlaysWebView({ overlay: true })`）下，必须显式配置键盘行为。`adjustResize` 不是所有设备的默认值，而 `resizeOnFullScreen` 在 fullscreen 模式下默认不生效。
