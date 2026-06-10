# Deploy TODO

## deploy/README.md 中 compose.dev.yaml 标注过时（发现日期 2026-06-10）

- `deploy/README.md` 目录结构里 compose.dev.yaml 标注「本地开发（仅 MySQL）」，实际该文件含 mysql 与 coturn 两个服务，待修正。
- 来源：CLAUDE.md 梳理 review 中核实的预存问题，按规范不顺手修。

## dual-ip-deployment-notes.md 头部"临时文档"标注与正式记录地位不符（发现日期 2026-06-10）

- `deploy/docs/dual-ip-deployment-notes.md` 头部自称「临时文档，用于上下文压缩后继续工作」，但 `deploy/AGENTS.md` 两处（资产索引、TURNS 段）把它当正式记录引用，标注会误导读者低估其可信度，待修订头部状态标注。

## coturn 月度无脑重启（部署机 root crontab，每月 1 号 03:00）

- 现状：`certbot renew --cert-name edge.coclaw.net --standalone ... --quiet && docker compose restart coturn`。`certbot renew` 不论是否真续都返回 0，导致 coturn 每月被白重启一次（影响 TURN 连接）。
- 修复方向：改用 `--deploy-hook` 写 marker 文件，cron 末尾检测 marker 决定是否 restart；同时把 `&&` 改成 `;` 让判断独立于 certbot 退出码。
- 影响面：粗糙但不致命，coturn 影响 TURN 中继，每月一次发生在 03:00 凌晨低峰期。
- 对照：仓库内 `certbot-renew` 服务（`im.coclaw.net` 走 webroot）已经用 deploy-hook + nginx SIGHUP，是正确做法；只有 root crontab 这条 standalone 路径滞后。
