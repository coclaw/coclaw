# CoClaw OpenClaw 插件本地更新 SOP（link 模式）

> 目标：在本地开发 `plugins/openclaw` 时，稳定地让 gateway 使用 workspace 中的源码，避免 `unknown channel id`、半更新状态和重复折腾。

## 关键结论

1. 本地开发推荐使用：
   - `openclaw plugins install --link /home/xhx/.openclaw/workspace/coclaw/plugins/openclaw`
2. **首次 link 成功后**，后续代码更新通常只需：
   - `openclaw gateway restart`
3. 不要把“卸载 + 删除 extensions 目录 + 再安装”作为日常流程。

## 一次性初始化（仅一次）

```bash
openclaw plugins install --link /home/xhx/.openclaw/workspace/coclaw/plugins/openclaw
openclaw gateway restart
openclaw plugins doctor
```

初始化后，配置应满足：
- `plugins.load.paths` 包含 `/home/xhx/.openclaw/workspace/coclaw/plugins/openclaw`
- `plugins.entries.coclaw.enabled = true`
- `plugins.installs.coclaw.source = "path"`

## 日常开发更新

```bash
# 改代码后
openclaw gateway restart
openclaw plugins doctor
```

> 正常情况下不需要再次执行 install/uninstall。

## 为什么会出现 `channels.coclaw: unknown channel id: coclaw`

这表示：
- 配置里还有 `channels.coclaw`
- 但插件 `coclaw` 没有成功被发现/加载

常见触发方式：
- 先卸载/清理了插件目录
- 但 link/安装没有成功完成
- 导致“渠道配置存在，但插件不存在”的半残状态

## 故障恢复顺序（重要）

1. 先修复插件发现/加载（恢复 link + entry enabled）
2. 再保留/恢复 `channels.coclaw`
3. 最后 `openclaw gateway restart`

不要先删 `channels.coclaw` 当常规方案（除非为了临时抢救启动）。

## 风险与边界

- 插件代码在 gateway 进程内执行；有语法/启动级错误会导致 gateway 启动失败。
- **好消息**：对于 gateway 主流程，插件代码是在重启/启动时重新加载；平时改源码不会立即生效。
- 但某些 `openclaw plugins ...` 管理命令本身也会触发插件相关加载/探测，可能产生日志或副作用；因此脚本化操作建议先停 gateway 再做高风险变更。

## 禁止作为日常流程的操作

- 反复 `plugins uninstall` + `plugins install <path>`
- 手动删除 `~/.openclaw/extensions/coclaw` 后不校验 config 就重启
- 在未确认插件可加载时直接恢复 `channels.coclaw`

## 建议保留的最小检查

```bash
openclaw gateway status
openclaw plugins doctor
openclaw plugins list
```

若需要检查配置关键字段：

```bash
cat ~/.openclaw/openclaw.json
```
