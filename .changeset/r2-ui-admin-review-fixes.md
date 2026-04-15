---
"@coclaw/ui": patch
---

ui: 修复 admin 页面 review 发现的两处数据一致性问题

- `AdminClawsPage` / `AdminUsersPage`：重入页面时从 `adminStore.claws.search` / `adminStore.users.search` 回显 searchInput，避免"输入框空 / 列表仍按旧 search 过滤"的不同步状态
- `auth.store.logout()`：末尾补 `useAdminStore().$reset()`，防止上一位管理员的 dashboard / claws / users 聚合数据和搜索词残留到下一位登录的管理员会话
