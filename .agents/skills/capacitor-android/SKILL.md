---
name: capacitor-android
description: Capacitor Android 开发规范与约束。Use when 进行 Android App 构建、调试、配置、原生插件开发等工作。
---

# Capacitor Android 开发

- **决策文档**：`docs/decisions/adr-mobile-desktop-framework.md`
- 前端与 Web 端共享同一 `ui` 代码库，Capacitor 消费 `vite build` 产物
- Android 原生工程位于 `ui/android/`

## 本机环境

- Java 21（OpenJDK）：`/usr/lib/jvm/java-21-openjdk-amd64`（Capacitor 8 要求 Java 21+）
- Android SDK：`~/android-sdk`（API 35、Build Tools 35.0.0）
- 环境变量（`JAVA_HOME`、`ANDROID_HOME`）已配置在 `~/.bashrc`
- 网络受限时使用本机代理（参见 `local-proxy` skill）
- WSL2 环境，无法直接使用 Android 模拟器

## 何时需要 build APK

- 仅当修改了 Capacitor 原生层代码（如 `ui/android/` 下的文件、Capacitor 配置、原生插件等）时才需要重新 build APK
- 仅修改 Web 层代码（Vue 组件、JS、CSS 等）时不需要 build APK——Web 部分通过 `vite build` 产物更新即可
