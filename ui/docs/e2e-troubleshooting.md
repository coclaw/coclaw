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

## 快速检查清单

- `ui/playwright.config.js` 中前端命令是否为 `pnpm dev ...`
- `ui/vitest.config.js` 是否排除了 `e2e/**`
- `pnpm e2e` 是否能稳定得到 `1 passed`（或对应用例数）
