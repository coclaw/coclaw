---
"@coclaw/openclaw-coclaw": patch
---

feat(plugin): add coclaw.env diag log with platform/version info on ws connect

插件间接依赖平台相关二进制（`@coclaw/pion-ipc-*` 的 npm 平台子包），诊断问题时需要快速获取 claw 端的运行环境。新增 `coclaw.env` 单行诊断日志，覆盖 webrtc 选型 + 插件/OpenClaw 版本 + OS/arch/CPU/内存：

```
coclaw.env impl=pion plugin=0.14.0 openclaw=4.5.0 platform=linux arch=x64 node=v22.22.0 osrel=6.6.87 cpu="AMD Ryzen 7 8745H" cores=8 mem=11.7GB
```

**输出时机**：
- `bridge.start()` 完成后：**只本地** `logger.info` 一次（gateway 日志可见，便于本地排查）
- 每次 `ws.open`（首次连接 + 每次重连）：**只远程** `remoteLog` 一次

两端互不重复：ws.open 是唯一的远程来源，避免 "start 入 buffer + ws.open 再发" 的重复问题；server 重启重连后能立即看到当前 claw 的环境信息。

**关键设计**：
- `getPlatformInfoLine()` 纯缓存的同步轻量调用（`process.*` 常量 + `os.release/cpus/totalmem`），模块级缓存一次后零开销，可被 ws 重连路径放心频繁调用
- 显式避免 `process.report.getReport()`（重量级同步调用，曾怀疑与 native 模块初始化期产生时序冲突）
- `ws.open` 内**先 `setRemoteLogSender` 再 `remoteLog(envLine)`**：保证环境信息随当前 sock 立即 flush；sender 闭包仅 `sock.send`，不回调 `remoteLog`，无循环依赖
- 每字段独立 `try/catch` 尽力而为：单项失败不影响其它字段；CPU model 的控制字符（C0 + DEL）被清洗为空格以保证 `key="value"` 解析格式

RPC 契约不变；gateway 方法注册不变；仅新增一条 remoteLog 日志。
