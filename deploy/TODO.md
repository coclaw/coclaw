# Deploy TODO

## Ops

- [ ] **coturn 月度无脑重启**（部署机 root crontab，每月 1 号 03:00）
  - 现状：`certbot renew --cert-name edge.coclaw.net --standalone ... --quiet && docker compose restart coturn`。`certbot renew` 不论是否真续都返回 0，导致 coturn 每月被白重启一次（影响 TURN 连接）。
  - 修复方向：改用 `--deploy-hook` 写 marker 文件，cron 末尾检测 marker 决定是否 restart；同时把 `&&` 改成 `;` 让判断独立于 certbot 退出码。
  - 影响面：粗糙但不致命，coturn 影响 TURN 中继，每月一次发生在 03:00 凌晨低峰期。
  - 对照：仓库内 `certbot-renew` 服务（`im.coclaw.net` 走 webroot）已经用 deploy-hook + nginx SIGHUP，是正确做法；只有 root crontab 这条 standalone 路径滞后。
