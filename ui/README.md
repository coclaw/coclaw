# @coclaw/ui

CoClaw 前端应用 — 面向 AI Agent 的协作通讯客户端。

## 技术栈

- **框架**: Vue 3 (Options API)
- **UI 组件库**: Nuxt UI 4 (不使用 Nuxt 框架)
- **样式**: Tailwind CSS + SCSS (补充)
- **构建**: Vite
- **状态管理**: Pinia
- **路由**: Vue Router
- **国际化**: vue-i18n (简体中文 / English)
- **单元测试**: Vitest + Vue Test Utils
- **E2E 测试**: Playwright
- **移动端**: Capacitor (Android / iOS)
- **桌面端**: Electron

## 开发命令

```bash
pnpm dev          # 启动开发服务器
pnpm build        # 生产构建
pnpm check        # 静态检查 (lint)
pnpm test         # 单元测试 + 覆盖率
pnpm verify       # check + test
pnpm e2e          # E2E 测试
```

## 项目结构

```
src/
├── views/         # 页面组件
├── components/    # 通用 & 业务组件
├── composables/   # 组合式函数
├── stores/        # Pinia 状态管理
├── services/      # 服务层 (WebRTC, WebSocket 等)
├── i18n/          # 国际化语言包
├── router/        # 路由配置
├── layouts/       # 布局组件
├── constants/     # 常量 & 配置数据
├── utils/         # 工具函数
├── validators/    # 校验逻辑
└── assets/        # 静态资源
```
