# 桌面端（Electron）发布产物分发

> 适用范围：Windows / macOS 的 Electron 安装包与自动更新分发。
> 壳子构建命令见 `ui/CLAUDE.md` 的 “Electron 桌面壳子”；签名/公证见 `ui/.env.example`。

桌面端走 electron-updater 的 generic provider，更新源就是本部署自己的 CDN
（`https://<域名>/releases/{win,mac}/`），规避 GitHub Releases 国内访问不稳定。

## 服务端已就绪（无需手动建目录）

- nginx 已配 `/releases/` 路由（`deploy/nginx/modes/app-*.conf.template`）：
  `latest*.yml` 走 `no-cache`（每次回源拿最新版本清单），安装包/`.blockmap` 走
  `immutable` 长期缓存（文件名含版本号）。
- 容器启动脚本 `deploy/nginx/scripts/init.sh` 幂等创建 `releases/{win,mac,android}` 子目录。
- 宿主机 `deploy/static/` 挂载到 nginx 容器的 `/usr/share/nginx/html`（`compose.yaml`）。
  因此发布目标就是宿主机的 `deploy/static/releases/<平台>/`。
  > `deploy/static/` 已被 `.gitignore` 忽略——它是 rsync 投放的运行时产物目录，不入库。

## 发布步骤

1. 在 macOS / Windows（或 WSL2 出 Windows 包）构建，配齐签名/公证凭据（`ui/.env.example`）：
   ```bash
   pnpm --filter @coclaw/ui electron:build:win   # Windows: nsis 安装包
   pnpm --filter @coclaw/ui electron:build:mac   # macOS: dmg + zip（zip 供自动更新）
   ```
   产物在 `ui/dist-electron/`。
2. 把对应平台产物 rsync 到部署机的 `deploy/static/releases/<平台>/`：
   - **win**：`coclaw-setup-<版本>.exe` + `.blockmap` + `latest.yml`
   - **mac**：`*.dmg` + `*-mac.zip` + `*.blockmap` + `latest-mac.yml`
3. 无需重启 nginx：`latest*.yml` 是 no-cache，客户端下次检查即拿到新版本。

## 要点

- **macOS 必须有 `zip` 产物**：electron-updater 在 mac 上靠 zip 应用更新，缺它会抛
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND`（dmg 仅用于首次手动安装）。`electron:build:mac` 已产出 dmg+zip。
- **portable 版不参与自动更新**（`electron:build:win:portable`），不要投放到 `releases/`。
- `latest.yml` / `latest-mac.yml` 必须与安装包一起投放，否则客户端无法发现更新。
