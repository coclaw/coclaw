---
"@coclaw/ui": minor
---

ui: admin 用户管理页 AdminUsersPage

- 新建 `AdminUsersPage.vue`（替换原占位实现）：UTable 展示用户列表（name/loginName/clawCount/createdAt/lastLoginAt）
- 顶部搜索框按用户名或登录名过滤，300ms 去抖；输入变化时 `resetUsers()` 并重新拉取
- 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
- 移动端降级为卡片列表，展示用户名、@登录名、绑定实例数、注册时间、最近登录
- i18n 新增 `admin.users.{searchPlaceholder,columnName,columnLoginName,columnClawCount,columnCreatedAt,columnLastLogin}`，12 语言同步
- 清理 `admin.common.comingSoon`：仅原占位页引用，AdminUsersPage 完全落地后该 key 成孤儿
