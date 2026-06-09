---
name: e2e-test
description: E2E 测试执行规范与踩坑约束。Use when 执行、编写、调试 E2E 测试，或涉及 Playwright、e2e 目录下文件的改动。
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

## 浏览器内核（自动安装）

- `run.js` 在跑测试前自动 `playwright install chromium`（幂等，已装秒过）：新机器 / CI / 升级 Playwright 后首次跑会自动补齐浏览器，无需手动安装。
- 浏览器二进制**不走 npm registry**——`.npmrc` 的 registry 镜像对它无效。国内若安装卡在官方 CDN，另设 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` 后重试（与 npm registry 是两套独立配置）。安装失败时 run.js 会打印显著提示。详见 `docs/e2e-troubleshooting.md` 卡点 8。

## 测试账号

- 后端测试账号（本地认证）：loginName=`test`；password=`12345678`
- `globalSetup` 会自动创建该账号

## 标签分类

每个测试用例通过 title 中的 `@tag` 标注分类，配合 Playwright `--grep` 过滤使用。

| 标签 | 含义 | 涉及文件 |
|------|------|---------|
| `@auth` | 登录/注册/认证故障 | `auth`, `register`, `api-failure-auth` |
| `@bind` | 绑定/解绑/Claim | `claw-bind-unbind`, `claim` |
| `@chat` | 核心聊天业务 | `chat-flow`, `chat-input`, `chat-cancel-restore`, `slash-command`, `topic-integration`, `multi-agent` |
| `@resilience` | 异常/网络/容错 | `chat-resilience`, `network-offline`, `network-slow`, `api-failure-data` |
| `@ui` | 导航/布局/设置/交互 | `navigation`, `about`, `user-profile-settings`, `chat-layout-debug`, `pull-refresh` |
| `@rtc` | WebRTC 传输 | `rtc-transport` |
| `@file` | 文件传输/浏览 | `file-transfer`, `file-browser` |

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

## 本机可视化测试（锁屏 / 焦点 / 多屏）

在本机用 headed Playwright 或弹 Electron 客户端做可视化测试 / 调试时，用户能否离开屏幕取决于驱动的是哪一层：

- **网页 UI（渲染区）**：经 CDP 驱动，锁屏、失焦、被别的窗口完全盖住都不影响发指令与截图；Electron 主窗已设 `backgroundThrottling: false`，被遮挡也不降帧。用户可放心锁屏 / 切到别的 app。CDP 注入的输入与系统物理键盘是两条独立通道——用户在另一屏正常打字不会串进被测窗口，测试也无需抢占用户焦点（仅拉起 / 启动窗口那一下可能短暂夺焦）。
- **原生外壳**（托盘菜单、自定义标题栏的系统按钮、原生右键菜单 / 对话框、Dock）：CDP 够不着，只能系统级抓屏 + 模拟点击 → 锁屏会抓到黑屏，失焦会把点击打到前台别的窗口。这类测试要求屏幕解锁且被测窗口在最前台。
- **开测前主动告知用户**这步验的是原生外壳还是网页 UI，让其知道当下能否锁屏 / 切走。

多屏把测试浏览器弹到副屏（不挡终端）：

- Playwright 位置来源优先级：环境变量 `E2E_WINDOW_POSITION="x,y"` > 本机专属文件 `e2e/.window-position`（gitignored）。坐标用 macOS 全局逻辑坐标（主屏左上角 0,0；副屏在右 x 为正、在左为负）。**4K 屏跑 2x 缩放时逻辑宽是 1920 而非 3840，必须用逻辑值**。
- 不确定副屏原点时用 Electron 的 `screen.getAllDisplays()` 实测各屏 `bounds`（受缩放影响，别按物理像素猜）。
- Electron 客户端的窗口位置由 `mainWindowState` 记住，手动拖到副屏一次即留在那。

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
