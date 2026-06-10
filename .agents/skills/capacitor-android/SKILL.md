---
name: capacitor-android
description: Capacitor Android 开发规范、常用命令与约束。Use when 进行 Android App 构建、调试、配置、原生插件开发等工作。
---

# Capacitor Android 开发

- **决策文档**：`docs/decisions/adr-mobile-desktop-framework.md`
- **签名与发布配置**：`ui/docs/android-release-config.md`
- 前端与 Web 端共享同一 `ui` 代码库，Capacitor 消费 `vite build` 产物
- Android 原生工程位于 `ui/android/`

## 本机环境

以下为 WSL2 开发机专属配置，Mac 上不适用。

- Java 21（OpenJDK）：`/usr/lib/jvm/java-21-openjdk-amd64`（Capacitor 8 要求 Java 21+）
- Android SDK：`~/android-sdk`（API 35、Build Tools 35.0.0）
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

- 仅当修改了 Capacitor 原生层代码（如 `ui/android/` 下的文件、Capacitor 配置、原生插件等）时才需要重新 build APK
- 仅修改 Web 层代码（Vue 组件、JS、CSS 等）时不需要 build APK——Web 部分通过 `vite build` 产物更新即可
