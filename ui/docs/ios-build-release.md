# iOS 构建与发布（Capacitor）

> 适用范围：`coclaw/ui` 的 iOS 壳子（Capacitor）。与 Android 共用前端与 `capacitor.config.ts`，
> 仅原生工程在 `ui/ios/`。桌面端见 `ui/docs/designs/electron-desktop-shell.md` 与
> `deploy/docs/desktop-releases.md`。

iOS 与已验证的 Android APK 共用同一套远程加载壳（`server.url = https://im.coclaw.net`），
所以绝大多数原生能力靠 Capacitor 插件即可，无需写 Swift。本文档给出从零构建到归档的路径。

## 前置条件

- macOS + Xcode（建议 16+）。Linux/WSL2 无法构建 iOS。
- 归档真机包 / 上架需要 Apple Developer 账号（团队 ID）。**纯模拟器冒烟构建不需要账号**。
- 本工程用 **Swift Package Manager**（`ios/App/CapApp-SPM/`），不是 CocoaPods，**无需 `pod install`**。

## 构建步骤

```bash
# 1) 安装依赖（全新检出 / worktree 必做，否则下一步同步会缺插件）
pnpm install

# 2) 构建前端产物到 dist/
pnpm build

# 3) 同步到 iOS 原生工程（拷贝 dist/、刷新 Capacitor 插件清单 + SPM 依赖）
npx cap sync ios

# 4) 打开 Xcode 工程（SPM 工程直接开 .xcodeproj）
npx cap open ios          # 等价于 open ios/App/App.xcodeproj
```

> `Package.swift` 里引用的是 pnpm 哈希过的 `node_modules/.pnpm/...` 路径；只要先 `pnpm install`
> 再 `npx cap sync ios`，路径就会随当前锁文件自洽。改动依赖 / 重生锁文件后务必重跑这两步。

## 签名与归档

工程已设为 **自动签名**（`CODE_SIGN_STYLE = Automatic`，App target）。缺的只是**开发团队 ID**——
它属于 Apple 账号，不入库。三种注入方式任选：

- **Xcode UI**：Signing & Capabilities → Team 选你的团队，Xcode 自动配置 provisioning。
- **命令行 / CI**：
  ```bash
  xcodebuild -project ios/App/App.xcodeproj -scheme App \
    -configuration Release -archivePath build/App.xcarchive archive \
    DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" -allowProvisioningUpdates
  ```
  `IOS_DEVELOPMENT_TEAM` 见 `ui/.env.example`。
- **模拟器冒烟**（无需账号）：`xcodebuild ... -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO`。

导出 IPA：Xcode Organizer → Distribute App，或 `xcodebuild -exportArchive`。

## 本地无签名模拟器工作流

无 Apple 账号即可在本机模拟器跑通完整 app（脚本 `scripts/ios-sim.sh`）：

```bash
# 1) 无签名构建模拟器包，产物 dist-ios/App.app（gitignored）
pnpm ios:sim:build

# 2) 装到模拟设备。无参数装默认清单（iPhone 17 / iPad Air 11-inch (M4) 走 iOS 26.5，
#    iPhone 13 / iPad (9th generation) 走 iOS 15.5 即最低支持版本；见脚本顶部
#    DEFAULT_DEVICES）；传设备名则只装指定的几台
pnpm ios:sim:install
pnpm ios:sim:install "iPhone 17"
```

装好后随时 `xcrun simctl boot <设备名>` + `open -a Simulator` 即可查看。注意：

- 模拟器 app 按设备隔离存储，**重新 build 后需重跑 install**（同 bundle id 覆盖安装）
- 新建或 erase 过的设备上没有 app，需要补跑一次 install
- iOS 15.5 runtime 是旧格式镜像（`simctl runtime add` / `xcodebuild -downloadPlatform` 均只认 iOS 16+），需从 Apple CDN 下载 dmg 后解出 `.simruntime` 放入 `~/Library/Developer/CoreSimulator/Profiles/Runtimes/`；换机时参照此路径重装

## 与 Android 的能力差异（已知、刻意）

- **后台保活：iOS 无对应能力。** Android 用前台服务（`KeepAliveService` + wake lock）维持后台连接；
  iOS 会挂起后台 app，没有等价机制，**不要伪造 `UIBackgroundModes`**（Apple 会拒审）。连接恢复已挂在
  `app:foreground` 上（`src/utils/capacitor-app.js` 的 `setupAppStateChange`，对所有原生平台生效），回前台即重连。
- **分享接收（Share Target）：暂缺。** Android 有 `SEND/SEND_MULTIPLE` intent filter；iOS 对应物是
  Share Extension target + App Group（`group.net.coclaw.im`），需 Apple 账号，**已知待办、暂不实现**。
- **推送（APNs）：不在范围内。** 前端未使用 `@capacitor/push-notifications` / `local-notifications`，
  Android APK 的推送同样未接（无 `google-services.json`）。若将来要做，再补 `aps-environment` 权限、
  Push capability 与 `AppDelegate` 的远程通知回调。

## 已就绪、无需改动（备查）

`coclaw://` URL scheme（`Info.plist` CFBundleURLTypes + `AppDelegate` 转发）、相机/麦克风/相册
用途描述、ATS（远程 https 加载）、安全区 / `viewport-fit=cover`、深色启动屏背景均已配齐。
