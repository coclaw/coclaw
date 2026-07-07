---
name: capacitor-android
description: Capacitor Android 开发规范、常用命令与约束。Use when 进行 Android App 构建、调试、配置、原生插件开发等工作。
---

# Capacitor Android 开发

- **决策文档**：`docs/decisions/adr-mobile-desktop-framework.md`
- **签名与发布配置**：`ui/docs/android-release-config.md`；`local.properties` / keystore 含密钥，不读取、不打印、不提交
- 壳与 Web 端共用同一 `ui` 代码库；App 运行时直连线上前端（`ui/capacitor.config.ts` 的 `server.url`），打进包里的 `dist` 产物不是 App 的 UI 来源
- Android 原生工程位于 `ui/android/`；SDK / 构建工具版本以 `ui/android/variables.gradle` 为准

## 本机环境

以下为 WSL2 开发机专属配置，Mac 上不适用。

- Java 21（OpenJDK）：`/usr/lib/jvm/java-21-openjdk-amd64`（Capacitor 8 要求 Java 21+）
- Android SDK：`~/android-sdk`；缺平台 / 构建工具时用 `sdkmanager`（已在 PATH）按 variables.gradle 要求补装
- 环境变量（`JAVA_HOME`、`ANDROID_HOME`）已配置在 `~/.bashrc`
- 网络受限时给 Gradle/SDK 下载配置本机 HTTP 代理
- WSL2 环境，无法直接使用 Android 模拟器

## 常用命令

构建链路仅 WSL2 开发机可用（见上节）；命令起点为仓库根。

```bash
# 同步前端产物到原生工程（cap sync 要求 webDir 即 ui/dist 存在；App 运行时实际加载线上前端）
cd ui && pnpm build && npx cap sync android

# Debug APK（默认 debug 签名，无前置）
cd ui/android && ./gradlew assembleDebug   # 产出 app/build/outputs/apk/debug/coclaw-<version>-debug.apk

# Release APK（前置：keystore 与 local.properties 签名配置，见 ui/docs/android-release-config.md）
cd ui/android && ./gradlew assembleRelease # 产出 app/build/outputs/apk/release/coclaw-<version>.apk
```

装机/真机调试：仓库内无脚本与文档支持，不收录命令。

## 何时需要 build APK

- 仅当修改了 Capacitor 原生层（`ui/android/` 下文件、`capacitor.config.ts`、原生插件、Gradle / Manifest / 依赖）时才需要重新 build 并重发 APK
- 仅修改 Web 层代码（Vue 组件、JS、CSS 等）不需要动 APK——App 直连线上前端，Web 改动经 web 部署即对 App 生效（本地 `vite build` 不会更新已装的 App）
- 新增原生能力前先确认壳是否已预埋对应插件与权限（以 `ui/android/app/src/main/AndroidManifest.xml` 和 `MainActivity.java` 注册的插件为准）；没预埋就意味着要发新 APK，而非只部署 Web

## 移动端坑位

- **safe area**：别只信 CSS `env(safe-area-inset-*)`——Android 14 及以下可能全为 0（仅 Android 15+ 可靠）；Web 端已用 `StatusBar.getInfo()` 注入 CSS 变量兜底
- **软键盘**：行为由三处共同决定——Manifest 的 `windowSoftInputMode="adjustResize"`、`capacitor.config.ts` 的 `Keyboard.resizeOnFullScreen: true`、Web 端聚焦后滚动兜底；改键盘表现时三处一起看
- **WebView 隐式权限**：Capacitor WebView 的权限需求可能超出直觉——如麦克风除 `RECORD_AUDIO` 外还需 `MODIFY_AUDIO_SETTINGS`
