---
"@coclaw/ui": minor
---

ui: admin 实例管理页 AdminClawsPage

- 新建 `AdminClawsPage.vue`：UTable 展示实例列表（name/online/user/pluginVersion/createdAt），`#expanded` 槽显示 agent × model 明细（null → 「信息暂不可用」；[] → 「无 Agent」）
- 顶部搜索框按名称过滤，300ms 去抖；输入变化时 `resetClaws()` 并重新拉取
- 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
- mount 时连接 admin SSE，`snapshot` / `claw.statusChanged` / `claw.infoUpdated` 分别映射到 store 的 `applyOnlineSnapshot` / `updateClawStatus` / `updateClawInfo`；`beforeUnmount` 关闭连接
- 移动端降级为卡片列表，点击卡片切换展开状态显示 agent 明细
- i18n 新增 `admin.claws.{searchPlaceholder,columnName,columnStatus,columnUser,columnVersion,columnCreatedAt,expandAgentName,expandModel,noAgentModels,emptyAgents}`，12 语言同步
