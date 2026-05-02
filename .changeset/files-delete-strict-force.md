---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.files.delete` 的 `force` 参数改为严格 boolean true 校验。原先 `if (params?.force)` 把任意 truthy 值（如字符串 `"false"`、数字 `1`、对象）当作 force 使用，错配的客户端误传可能触发非空目录递归删除。
