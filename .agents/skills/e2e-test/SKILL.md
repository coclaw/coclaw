---
name: e2e-test
description: E2E 测试执行规范与踩坑约束。TRIGGER when：用户要求执行、编写、调试 E2E 测试，或涉及 Playwright、e2e 目录下文件的改动。
---

# E2E 测试（Playwright）

## 执行命令

在 `ui/` workspace 下执行：

```bash
pnpm e2e:ci              # 推荐：自动处理 WSL2/CI 环境兼容性
pnpm e2e:ci -- e2e/auth.e2e.spec.js   # 指定单个测试文件
pnpm e2e                  # 有 GUI 的环境下可看到浏览器
pnpm e2e:ci -- --grep @auth           # 按标签运行一类
pnpm e2e:ci -- --grep "@auth|@bind"   # 组合多个标签
pnpm e2e:ci -- --grep-invert @resilience  # 排除某类
```

- `e2e/run.js` 会自动检测环境（macOS / Linux / WSL2）决定是否用 xvfb-run
- 从项目 root 执行时：`pnpm --filter @coclaw/ui e2e:ci`
- 当用户明确要求时才执行 E2E 测试

## 测试账号

- 后端测试账号（本地认证）：loginName=`test`；password=`123456`
- `globalSetup` 会自动创建该账号

## 标签分类

每个测试用例通过 title 中的 `@tag` 标注分类，配合 Playwright `--grep` 过滤使用。

| 标签 | 含义 | 涉及文件 |
|------|------|---------|
| `@auth` | 登录/注册/认证故障 | `auth`, `register`, `api-failure-auth` |
| `@bind` | 绑定/解绑/Claim | `bot-bind-unbind`, `claim` |
| `@chat` | 核心聊天业务 | `chat-flow`, `chat-input`, `chat-cancel-restore`, `slash-command`, `topic-integration`, `multi-agent` |
| `@resilience` | 异常/网络/容错 | `chat-resilience`, `network-offline`, `network-slow`, `api-failure-data` |
| `@ui` | 导航/布局/设置/交互 | `navigation`, `about`, `user-profile-settings`, `chat-layout-debug`, `pull-refresh` |
| `@rtc` | WebRTC 传输 | `rtc-transport` |
| `@file` | 文件传输 | `file-transfer` |

新增测试时须在 test title（或所属 describe title）中包含对应标签。

## 编写规范

- 测试文件放在 `ui/e2e/`，命名为 `*.e2e.spec.js`
- 公共 helper（登录、导航、安全输入等）统一放在 `e2e/helpers.js`，测试文件应优先从该模块导入
- Bug 修复涉及 UI 行为时，须补充对应的 E2E 测试用例

## 关键约束

### 禁止对 Nuxt UI 复合输入组件使用 fill()

`fill()` 通过 CDP 直接设置 value，绕过浏览器事件序列，导致 Vue v-model 响应式链断裂。

- 对 `UTextarea` 等复合组件，必须使用 `e2e/helpers.js` 中的 `typeText()` 或 `pressSequentially()`
- 对 `UInput`（如登录表单）`fill()` 目前表现正常，但不保证所有 Nuxt UI 组件均如此
- 详见 `docs/e2e-troubleshooting.md` 卡点 3

### headless 必须为 false

`playwright.config.js` 中 `headless: false`，**禁止改为 true**。

WSL2 下 Chrome（headless 和 headed + WSLg）的动画帧渲染异常，导致 Playwright actionability "stable" 检查永远无法通过，所有 `click()` 超时。详见 `docs/e2e-troubleshooting.md` 卡点 4。

### webServer 命令

`playwright.config.js` 中前端启动命令必须写 `pnpm dev ...`，不要写 `pnpm --filter @coclaw/ui dev ...`，否则会导致 webServer 启动异常或挂起。详见 `docs/e2e-troubleshooting.md` 卡点 1。

### Vitest 排除 e2e

`vitest.config.js` 必须排除 `e2e/**`，避免 `pnpm test` / `pnpm coverage` 误扫 Playwright 用例。详见 `docs/e2e-troubleshooting.md` 卡点 2。

## 踩坑记录

完整踩坑记录见 `ui/docs/e2e-troubleshooting.md`。以下为编写测试时常见的逻辑陷阱：

### 判断发送完成：用 btn-stop 消失，不要用 btn-send 出现

发送消息后输入框被清空、文件被清除，`canSend` 为 false，`btn-send` 不会渲染（`v-else-if="canSend"`）。因此 `await expect(page.getByTestId('btn-send')).toBeVisible()` 永远超时。正确做法：

```js
// ✅ 等待 stop 按钮消失 = sending 结束
await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

// ❌ btn-send 在输入框为空时不渲染，会永远等待
await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 180_000 });
```

### Store 中消息 content 可能是 block 数组

通过 `evalStore` 检查用户消息内容时，`m.message.content` 可能是 string（乐观消息），也可能是 block 数组 `[{type:'text', text:'...'}]`（OpenClaw sessions.get 返回的服务端消息）。必须处理两种格式：

```js
const c = m.message.content;
const texts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text)
    : [];
```

### 测试数据必须跨 run 唯一

Chat session 会积累历史消息，同一 session 中前次 E2E 运行残留的消息仍然存在。如果用通用文件名或固定文本做 regex 匹配，会匹配到陈旧数据。文件名和断言文本必须包含唯一标识（如 `Date.now()` 时间戳）：

```js
// ✅ 时间戳确保唯一
const ts = Date.now();
const fileName = `e2e-test-${ts}.txt`;

// ❌ 固定名称会与历史数据碰撞
const fileName = 'e2e-test.txt';
```
