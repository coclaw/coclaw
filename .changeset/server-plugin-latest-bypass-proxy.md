---
'@coclaw/server': patch
---

修复 plugin-latest 查询在 shell 存在 `HTTPS_PROXY` 时报 HTTP 400。

axios 1.x 遇到 env 里的 HTTPS_PROXY 会自动走代理，但其代理实现对公网 registry 的 CONNECT 处理常与本地代理中间件不兼容（curl 可 200，axios 报 400 / socket hangup）。此处固定 `proxy: false`：本服务只请求公网 npm/阿里镜像，部署环境一般直连，本地开发也无需代理走 npm。
