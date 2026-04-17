# 本地开发环境

> 适用场景：开发者在本机运行 CoClaw server + UI + 对接本地 OpenClaw gateway

## 依赖容器

本地开发需要两个容器支撑：

| 容器 | 用途 |
|------|------|
| `coclaw-mysql` | server 的数据库 |
| `coclaw-coturn` | WebRTC 中继 —— 浏览器（Windows 侧）↔ OpenClaw 插件（WSL2 侧）跨虚拟机通信**必须经 TURN relay** |

定义在 `deploy/compose.dev.yaml`，与生产 `compose.yaml` 独立。

## 启动方式

在**仓库根**或任一 workspace 子目录运行 `pnpm dev`，都会自动确保容器就绪：

- 根 `pnpm dev` —— 串行调用 `scripts/ensure-dev-dockers.sh` 再并发起 server + UI
- 子目录 `pnpm dev`（server/ 或 ui/）—— 各自前缀调用同一个 ensure 脚本

`ensure-dev-dockers.sh` 幂等：容器不存在则创建，存在已停则启，已在跑则 `docker compose up -d --wait` 快速返回（~0.5s）。**首次启动**时 mysql init 约 15-30s，等健康检查通过后才进入 node 启动阶段，避免 server 启动时 DB 还没准备好。

容器是 detached 启动，CTRL+C 只停 node 进程，容器保留。手动清理：

```bash
docker compose -f deploy/compose.dev.yaml down
```

## coturn 配置要点

本地开发的 coturn 使用以下参数（见 `deploy/compose.dev.yaml`）：

```
--listening-ip=127.0.0.1
--relay-ip=127.0.0.1
--external-ip=127.0.0.1
```

三者都钉死在 loopback，原因：

**不钉死会踩的坑** —— coturn 默认枚举所有本机网口作为 listening 和 relay bind。WSL2 虚拟机的主机 IP 会随**切换网线/WiFi、Windows 休眠/重启、WSL2 重启**发生漂移。老接口失效后，coturn 仍在死循环尝试 bind 旧 IP 的 relay 端口（`--min-port=50000 --max-port=50100`），日志刷屏：

```
bind: Cannot assign requested address  (errno=99)
```

主监听端口（3478）虽然还在，但 TURN allocation 因为 relay 端口 bind 失败无法完成，UDP 入包堆积在 kernel 队列里没人读。浏览器看到的症状：ICE 卡在 `checking`，12 秒后 pion 侧关 PC 进入无限重连循环。

**钉死 loopback 的正当性**：

- coturn 在 host 网络模式运行，监听 127.0.0.1:3478
- OpenClaw 插件（WSL2 本机）通过 localhost 直达 ✓
- Windows 浏览器借 WSL2 的 localhost 端口转发自动到达 ✓
- relay 端口也在 127.0.0.1，双方通过 loopback 中继
- 回环接口**永不消失**，IP 漂移影响不到它

**生产环境不能这么做**：生产走独立的 `deploy/scripts/coturn-start.sh`，必须 bind 公网 IP 让外网 peer 到达。
