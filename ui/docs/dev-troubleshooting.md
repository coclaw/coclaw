# 前端开发环境故障排查

## capacitor-app.js 层级与职责问题

**日期**：2026-04-07

**背景**：`src/utils/capacitor-app.js` 在构建时产生 Vite 警告——`use-notify.js` 和 `i18n/index.js` 被其动态 `import()` 引入，但已被其他大量模块静态导入，动态导入无法将其拆分到独立 chunk。

**处置**：将这两处动态 import 改为静态 import，消除构建警告。经评估确认无隐患：
- 模块引用提前到顶部，但实际调用仍在 `handleShareReceived()` 内部，该函数仅在 Capacitor 事件触发时执行（Vue app 已就绪），时序无影响
- 无循环依赖风险（这两个模块不依赖 `capacitor-app.js`）
- 这两个模块本就在主 chunk 中，对产物体积零影响

**遗留架构问题（待 #159 一并解决）**：
1. **层级倒置**：`utils/capacitor-app.js` 向上依赖了 `composables/use-notify.js`，违反了 utils 作为底层工具的定位
2. **业务逻辑内聚在工具层**：`handleShareReceived()` 直接在 utils 中执行业务处理（通知用户），而同文件中其他功能（`appStateChange`、`networkStatusChange`）均通过 `dispatchEvent(new CustomEvent(...))` 抛出事件由上层消费
3. **模块定位不准确**：`capacitor-app.js` 本质是原生壳与 Web 层的桥接器，放在 `utils/` 不恰当，应作为独立的 bridge/adapter 层组织
4. **事件化改造受限**：若将 share 处理改为派发事件，上层处理完业务逻辑后仍需回调 `ShareIntent.clearFiles()` 清理原生临时文件，需要设计恰当的通信机制

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
