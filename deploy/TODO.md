# Deploy TODO

## deploy/README.md 中 compose.dev.yaml 标注过时（发现日期 2026-06-10）

- `deploy/README.md` 目录结构里 compose.dev.yaml 标注「本地开发（仅 MySQL）」，实际该文件含 mysql 与 coturn 两个服务，待修正。
- 来源：CLAUDE.md 梳理 review 中核实的预存问题，按规范不顺手修。

## dual-ip-deployment-notes.md 头部"临时文档"标注与正式记录地位不符（发现日期 2026-06-10）

- `deploy/docs/dual-ip-deployment-notes.md` 头部自称「临时文档，用于上下文压缩后继续工作」，但 `deploy/AGENTS.md` 两处（资产索引、TURNS 段）把它当正式记录引用，标注会误导读者低估其可信度，待修订头部状态标注。

## im.coclaw.net UI 部署改为拉 GHCR 镜像（与自托管一致）（发现日期 2026-06-20）

- 背景：评估 CD 上半部分（自动化镜像构建）时，用户决定把 im.coclaw.net 的 UI 部署从「rsync 静态产物 + `static/ui/current` 软链」切到「拉 GHCR `ghcr.io/coclaw/ui` 镜像、走 `ui-init`」，与自托管用户一致。当前软链方案只是早期 UI 高频更新的产物，现已进入维护期、发版不频繁，无需该快速路径。
- 这是 CD 工作的 **C 块，优先级低、不急**；先做 A（镜像构建 workflow）+ B（版本策略调整），跑通真实发布验证后再做 C。
- 改什么（delta，大部分现成）：① 一次性在部署机 `rm static/ui/current`（现为软链，ui-init 要真目录，两形态冲突），弃用 `releases/<tag>` + 软链 + `MAX_RELEASES` 裁剪那套；② 把 `deploy-ui.sh`/`deploy-run.sh --ui` 从 build+rsync+翻软链改成远端 `docker compose pull ui-init && up -d ui-init`；③ 给 ui-init 的 `cp -r` 加先清空再拷（它无 `--delete`，反复拷同目录会攒旧哈希资源）；④ 同步改 `deploy/README.md` + `docs/operations/deploy-ops.md`。nginx 配置、镜像构建、compose 结构都不用改。
- 权衡（要接受）：回滚方式从「秒翻软链指回旧版本」变成「在 compose 里把 ui 镜像钉到旧版本号再重跑 ui-init」，稍慢但维护期够用。

## coturn 月度无脑重启（部署机 root crontab，每月 1 号 03:00）

- 现状：`certbot renew --cert-name edge.coclaw.net --standalone ... --quiet && docker compose restart coturn`。`certbot renew` 不论是否真续都返回 0，导致 coturn 每月被白重启一次（影响 TURN 连接）。
- 修复方向：改用 `--deploy-hook` 写 marker 文件，cron 末尾检测 marker 决定是否 restart；同时把 `&&` 改成 `;` 让判断独立于 certbot 退出码。
- 影响面：粗糙但不致命，coturn 影响 TURN 中继，每月一次发生在 03:00 凌晨低峰期。
- 对照：仓库内 `certbot-renew` 服务（`im.coclaw.net` 走 webroot）已经用 deploy-hook + nginx SIGHUP，是正确做法；只有 root crontab 这条 standalone 路径滞后。
