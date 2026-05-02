---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` 的 `serverUrl` 入参校验拒绝空字符串。原先只检查 `typeof === 'string'`，`""` 通过校验后 `serverUrl ?? api.pluginConfig?.serverUrl` 因 `""` 不是 nullish 不会回退；最终 `unbindClaw` 内 `if (baseUrl)` 为 false 会跳过 server 端解绑直接清本地 config，产生孤儿 bot。错误信息从 `serverUrl must be a string` 改为 `serverUrl must be a non-empty string`。
