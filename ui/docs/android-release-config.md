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

- **SHA1**: `0F:DD:03:B4:8F:6A:53:E0:33:37:6B:FB:D0:85:B4:D8:4D:4F:17:F5`
- **SHA256**: `44:BE:2C:83:70:34:C4:BB:AA:A5:DB:4C:01:4D:0B:81:E2:9F:D9:0A:39:64:DE:0B:CA:E4:42:B2:11:DC:A4:41`
- **MD5**: `36:17:79:B5:BD:7D:17:04:24:CC:B0:5A:E6:0A:DB:BF`

## 发布主体

成都公演科技有限公司（Chengdu Gongyan Technology Co., Ltd.）

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
