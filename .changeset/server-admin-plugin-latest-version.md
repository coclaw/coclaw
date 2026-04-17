---
'@coclaw/server': minor
---

admin dashboard 新增「已发布的插件最新版本」展示。

server 启动后每小时并行查询 npm 官方源与阿里镜像（`@coclaw/openclaw-coclaw/latest`），两源版本不同时取镜像、单源失败另一源兜底、全部失败保留上一次缓存。admin dashboard 接口的 `version.plugin` 字段从原来读取本地 `plugins/openclaw/package.json`（部署容器中无此目录，永远为 `null`）改为返回 server 缓存的最新发布版本号，ui-admin 页面无需改动即可显示实际版本。
