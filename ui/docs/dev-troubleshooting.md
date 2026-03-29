# 前端开发环境故障排查

## ESM 模块缓存导致代码行为与源码不一致

**日期**：2026-03-29

**症状**：代码已修改并保存，Vite dev server 已重启，浏览器硬刷新（Ctrl+Shift+R）后仍运行旧版代码。表现为运行时行为与源码不一致（如 `webrtc-internals` 显示 `rtcConfiguration: {}` 但源码中明确传入了 iceServers）。

**根因**：浏览器的 ES Module 注册表是内存级缓存，独立于 HTTP 缓存。硬刷新只清除 HTTP 缓存，不清除模块注册表。当模块图的拓扑结构发生变更时（如动态 `import()` 改为静态 `import`、消除循环依赖、移动/重命名模块），Vite HMR 可能无法正确传播失效，导致浏览器继续使用旧模块实例。

**触发场景**：
- 动态 `import()` ↔ 静态 `import` 切换
- 消除或引入循环依赖（改变模块图拓扑）
- 移动或重命名模块文件

**解决**：DevTools → Application → Storage → **Clear site data**。

**排除方法**：打开无痕窗口或使用 `--user-data-dir` 启动干净 Chrome 实例对比测试。如果无痕/干净实例正常而常规 profile 异常，即为此问题。
