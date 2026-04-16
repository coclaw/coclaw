---
'@coclaw/ui': patch
---

Electron URL 白名单生产模式收紧：

`url-guard.js` 原本静态把 `localhost:5173` 加入 `TRUSTED_ORIGINS`，生产包亦然。攻击面虽小（要本地 5173 端口被恶意进程占用 + 用户被诱导点链接），但纵深防御角度应区分。

API 调整：`isTrustedUrl(urlStr, { allowDev })` —— 默认仅信任远程业务域；`main.js` 在开发模式下传 `allowDev: isDev` 才放行 `localhost:5173`。

测试同步补 4 个 allowDev=true 用例。
