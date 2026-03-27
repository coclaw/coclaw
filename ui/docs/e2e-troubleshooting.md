# UI E2E Troubleshooting

## 适用范围

- `coclaw/ui` 使用 Playwright 进行端到端测试的场景。

## 卡点 1：E2E 进程挂起或长期无结果

### 现象

- 执行 `pnpm e2e` 后长时间无测试结果。
- 仅看到部分 webServer 日志，测试用例不进入或不结束。

### 常见原因

- 在 `ui` workspace 内，把 Playwright `webServer.command` 写成了：
	- `pnpm --filter @coclaw/ui dev ...`
- 该写法在当前工作目录下可能触发不稳定行为，导致前端服务未按预期被 Playwright 管理。

### 处理方式

- 在 `ui/playwright.config.js` 中改为：
	- `pnpm dev --host 127.0.0.1 --port 4173`
- 保持 `port` 与 `baseURL` 一致，并保留合理 `timeout`（例如 `120000`）。

## 卡点 2：单测/覆盖率流程异常等待

### 现象

- `pnpm test` 或 `pnpm coverage` 看似已跑完测试，但进程不退出或行为异常。

### 常见原因

- Vitest 误扫 `e2e/**` 下的 Playwright 用例，导致测试运行器混用。

### 处理方式

- 在 `ui/vitest.config.js` 中明确限制与排除：
	- `test.include: ['src/**/*.test.js']`
	- `test.exclude: ['e2e/**']`

## 卡点 3：Nuxt UI 组件 + Playwright `fill()` 不触发 Vue 响应式

### 现象

- 使用 `page.getByTestId('chat-textarea').fill(text)` 填入文本后，点击发送按钮无效。
- 用户消息不出现在 DOM 中，发送按钮始终处于 disabled 状态。
- Playwright 不报错（`fill()` 和 `click()` 均正常完成）。

### 原因

- Playwright 的 `fill()` 通过 CDP 直接设置 input 的 `value` 属性，绕过了浏览器原生的 `input`/`compositionend` 等事件序列。
- Nuxt UI 的 `UTextarea`（以及可能的其它复合组件）依赖这些事件来触发 `@update:model-value`，进而驱动 Vue 的 `v-model` 响应式链。
- `fill()` 未触发事件 → 父组件的 `modelValue` 未更新 → `canSend` 计算属性为 `false` → 发送按钮 disabled → `onSubmit()` 被 `!this.canSend` 短路。
- 注意：对 `UInput`（如登录表单）使用 `fill()` 目前表现正常，但不保证所有 Nuxt UI 组件均如此。

### 处理方式

- 对 `UTextarea` 等复合输入组件，使用 `pressSequentially()` 代替 `fill()`：
	```js
	const textarea = page.getByTestId('chat-textarea');
	await textarea.click();
	await textarea.pressSequentially(text, { delay: 20 });
	// 确认 Vue 响应式已更新
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	```
- `pressSequentially()` 模拟逐键输入，触发完整的浏览器事件序列，Vue 响应式正常工作。
- `delay: 20` 保持合理输入速度，避免事件合并或丢失。
- 发送前始终用 `toBeEnabled()` 断言按钮状态，防止点击无效按钮。

### 推广建议

- 新增 E2E 测试中若涉及 Nuxt UI 的文本输入组件，默认使用 `pressSequentially()` 而非 `fill()`。
- 若测试中 `fill()` 后的操作"静默失败"（无报错但无效果），优先排查响应式链是否断裂。

## 快速检查清单

- `ui/playwright.config.js` 中前端命令是否为 `pnpm dev ...`
- `ui/vitest.config.js` 是否排除了 `e2e/**`
- `pnpm e2e` 是否能稳定得到 `1 passed`（或对应用例数）
- Nuxt UI 复合输入组件是否使用 `pressSequentially()` 而非 `fill()`
