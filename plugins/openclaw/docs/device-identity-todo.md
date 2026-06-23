# Device Identity — 待优化项

> 背景：OpenClaw 3.12 引入 WS scope 权限机制（CVE GHSA-rqpp-rjj8-7wv8），无 device 身份的连接 scope 会被清空。
> 插件新增了 `src/device-identity.js`，在 `realtime-bridge.js` 连接 gateway 时附带 Ed25519 签名的 device 字段。

## TODO

### 1. device token 持久化（可选）

当前每次 gateway 重启后，插件都用 gateway auth token + device 签名完成认证。OpenClaw 支持在首次配对后返回 `deviceToken`，后续连接可用 `auth.deviceToken` 替代 shared token，减少对 shared token 的依赖。

- 需要在 hello-ok 响应中提取 `auth.deviceToken`
- 存储到 `~/.openclaw/coclaw/device-token.json`
- 重连时优先使用 deviceToken，失败时 fallback 到 shared token
