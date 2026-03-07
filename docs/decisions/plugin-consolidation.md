# OpenClaw 插件合并方案（已定稿）

日期：2026-02-27

## 已确认结论

1. `tunnel` 与 `session-manager` 合并为一个 OpenClaw 插件项目。
2. 合并后对外仍是一个插件；插件内部保持模块化。
3. 插件内部共享目录命名采用 `common`（不使用 `core`）。
4. 保留 `session-manager` 命名语义。
5. OpenClaw `plugin id` 使用 `coclaw`。
6. CLI 命令名使用 `coclaw`。
7. npm 包名使用 `@coclaw/openclaw-coclaw`（scoped）。
8. monorepo 目录结构采用 `plugins/openclaw`。
9. 不再使用 `openclaw-plugins/` 作为顶层目录。
10. `plugins/` 作为统一插件父目录，为未来接入其他 agent 预留扩展位。

## 实施进度（2026-02-28）

- 已完成目录迁移并删除旧目录：`openclaw-plugins/`。
- 当前 gateway 配置仅加载 `plugins/openclaw` 对应的安装目录（`~/.openclaw/extensions/coclaw`）。

## 命名定稿（2026-03-07）

- npm 包名：`@coclaw/openclaw-coclaw`（scoped to `@coclaw` org）。
- plugin id：`coclaw`（= `openclaw.plugin.json` 中的 `id`，优先于从包名派生的 `idHint` `openclaw-coclaw`）。
- channel 名：`coclaw`（与 plugin ID 一致）。
