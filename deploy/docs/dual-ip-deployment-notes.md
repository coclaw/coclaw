# coturn 双域名/双 IP 部署变更记录

> 临时文档，用于上下文压缩后继续工作。

## 1. 目标

让 coturn 在 443 端口提供 TURNS (TLS) 服务，穿透严格防火墙。在同一台 ECS 主机上使用两个公网 IP：一个给 nginx，一个给 coturn。

## 2. 基础设施配置（已完成）

### 2.1 阿里云 ECS 双网卡

| 网卡 | 私网 IP | 公网 IP | 域名 | 模式 |
|------|---------|---------|------|------|
| eth0（主） | 172.17.225.209 | 8.137.116.232 | im.coclaw.net | 普通 NAT |
| eth1（辅） | 8.137.174.219 | 8.137.174.219 | edge.coclaw.net | EIP 网卡可见（直通） |

### 2.2 OS 网络配置（已完成，持久化）

- netplan: `/etc/netplan/60-eth1.yaml` — eth1 DHCP + 策略路由
- 策略路由表 1001: `from 8.137.174.219 → default via 8.137.175.253 dev eth1`
- cloud-init 网络配置已禁用: `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`
- 弹性网卡安全组：两个 ENI 共用同一安全组，端口 3478/443/50000-51000 已开放

### 2.3 TLS 证书（已完成）

- `edge.coclaw.net` 证书已签发（Let's Encrypt），存放在 `certbot/conf/live/edge.coclaw.net/`
- 签发方式：certbot standalone + `--network host` + `--http-01-address 8.137.174.219`
- 续期：root crontab 每月 1 日凌晨 3 点自动续期
- 证书目录权限已调整为 755（coturn 容器以 nobody 运行）

## 3. 代码变更清单

### 3.1 deploy/.env.example

新增可选配置段：`TURN_DOMAIN`, `TURN_TLS_PORT`, `TURN_TLS_CERT`, `TURN_TLS_KEY`, `NGINX_LISTEN_IP`, `TURN_LEGACY_IP`, `TURN_LEGACY_EXTERNAL_IP`

### 3.2 deploy/compose.yaml

- nginx ports: `"${NGINX_LISTEN_IP:-0.0.0.0}:80:80"` / `:443:443`
- server environment: 新增 `TURN_DOMAIN`, `TURN_TLS_PORT`
- coturn: 改用启动脚本 `entrypoint: ["/bin/sh", "/scripts/coturn-start.sh"]`，通过 environment 传参，volume 挂载脚本和证书
- coturn environment 新增: `TURN_TLS_PORT`, `TURN_TLS_CERT`, `TURN_TLS_KEY`, `TURN_LEGACY_IP`, `TURN_LEGACY_EXTERNAL_IP`

### 3.3 deploy/scripts/coturn-start.sh（新建）

- 根据环境变量动态构建 turnserver 命令
- `TURN_INTERNAL_IP` 未设置时回退到 `TURN_EXTERNAL_IP`
- `TURN_LEGACY_IP` 设置时通过 `--aux-server` 在旧 IP 上额外监听 3478
- `TURN_TLS_PORT` + 证书存在时启用 TLS（`--tls-listening-port`, `--cert`, `--pkey`, `--no-tlsv1`）
- 注意：coturn 4.9.0 不支持 `--no-tlsv1_1`（会报 unrecognized option）

### 3.4 server/src/routes/turn.route.js

URL 生成逻辑：
```
turn:TURN_DOMAIN:3478?transport=udp        （始终）
turn:TURN_DOMAIN:3478?transport=tcp        （始终）
turn:APP_DOMAIN:3478?transport=udp         （双域名模式，兼容旧 IP）
turn:APP_DOMAIN:3478?transport=tcp         （双域名模式，兼容旧 IP）
turns:TURN_DOMAIN:TLS_PORT?transport=tcp   （TLS 模式）
```

新增 `genTurnCredsForGateway()` — 过滤 `turns:` URL，兼容旧版 plugin（不支持 `turns:` scheme）。

### 3.5 server/src/bot-ws-hub.js & rtc-signal-hub.js

WebSocket 注入 TURN 凭证时使用 `genTurnCredsForGateway()`（不含 `turns:` URL）。

### 3.6 ui/src/services/webrtc-connection.js

`__buildIceServers()` 中的条件从 `url.startsWith('turn:')` 改为 `url.startsWith('turn:') || url.startsWith('turns:')`，确保 `turns:` URL 也附带 username/credential。

### 3.7 plugins/openclaw/src/webrtc/ndc-preloader.js

新增 `wrapNdcCredentials()` wrapper — 在 RTCPeerConnection 构造前对 iceServers 的 username/credential 做 `encodeURIComponent()`。详见根因分析。

## 4. 生产环境 .env 配置（im.coclaw.net）

```bash
# 变更的值
TURN_EXTERNAL_IP=8.137.174.219
TURN_INTERNAL_IP=8.137.174.219

# 新增
NGINX_LISTEN_IP=172.17.225.209
TURN_DOMAIN=edge.coclaw.net
TURN_TLS_PORT=443
TURN_TLS_CERT=/etc/letsencrypt/live/edge.coclaw.net/fullchain.pem
TURN_TLS_KEY=/etc/letsencrypt/live/edge.coclaw.net/privkey.pem
TURN_LEGACY_IP=172.17.225.209
TURN_LEGACY_EXTERNAL_IP=8.137.116.232
```

## 5. 当前部署状态

| 组件 | 状态 | 说明 |
|------|------|------|
| nginx | 绑定 172.17.225.209:80/443 | 正常 |
| coturn 主 | 8.137.174.219:3478 (UDP/TCP) + :443 (TLS) | 正常 |
| coturn legacy | 172.17.225.209:3478 (UDP/TCP) via --aux-server | 正常 |
| server | 已部署新镜像 (0.8.0) | 含 turn.route.js 变更 |
| UI | 已部署 ui-20260405-0157 | 含 turns: credential 修复 |
| 证书续期 | root crontab | 每月自动 |

## 6. 遇到的问题与解决

### 6.1 dhclient 导致路由表混乱

**现象**：测试 DHCP 发现 eth1 配置时，dhclient 添加了无 metric 的默认路由，抢占了 eth0 的默认路由，导致 im.coclaw.net SSH 断连。
**解决**：通过新 EIP (8.137.174.219) SSH 进入，删除 dhclient 路由，最终用 netplan 正确配置。

### 6.2 certbot standalone 端口冲突

**现象**：第一次尝试用 `-p 8.137.174.219:80:80` 运行 certbot 容器，Let's Encrypt 无法回连。原因是 Docker 端口映射的回程路由走了 eth0（非对称路由）。
**解决**：改用 `--network host` 运行 certbot，直接在主机网络栈绑定，策略路由生效。

### 6.3 coturn TLS 在 legacy IP 上绑定失败

**现象**：`--tls-listening-port=443` 会在所有 `--listening-ip` 上尝试绑定，legacy IP 的 443 被 nginx 占用，coturn 进入重试循环。
**解决**：改用 `--aux-server` 为 legacy IP 添加监听（只绑定 3478，不绑定 TLS 端口）。TLS 仅在 edge IP 上生效。

### 6.4 coturn 4.9.0 不支持 --no-tlsv1_1

**现象**：`turnserver: unrecognized option '--no-tlsv1_1'`，coturn 打印 help 后退出。
**解决**：移除该选项，只保留 `--no-tlsv1`。

### 6.5 certbot 证书目录权限

**现象**：coturn 容器以 `nobody:nogroup` (65534) 运行，无法读取 certbot 默认 700 权限的目录。
**解决**：`chmod 755` certbot/conf 及 live/archive 目录，`chmod 644` privkey 文件。

## 7. WebRTC 连接失败的根因分析

### 7.1 现象

- 其他用户（user:437）的 3 个 bot 全部通过 TURN relay 成功连接（累计 27+ 次 ICE connected）
- 当前用户（user:452）的 bot 始终失败（connecting → timeout → closed）
- coturn 日志中出现大量 `check_stun_auth: Cannot find credentials of user <1775414573>` — username 只有时间戳部分

### 7.2 关键线索

1. coturn auth 错误中的 username 格式为 `<1775414573>`（只有时间戳），而正确格式应为 `<1775414573:145937910625>`（timestamp:botId）
2. 成功的 user:437 的 bot 使用 **werift** WebRTC 实现（结构化传参）
3. 失败的 user:452 的 bot 使用 **ndc (node-datachannel)** 实现（URL 拼接）
4. Gateway 配置了 TURN 但 `ss` 显示没有到 coturn 的 UDP 连接 — ICE agent 根本没有发出 TURN 请求
5. 从容器内部和外部用 `turnutils_uclient` 测试 TURN 均正常

### 7.3 根本原因

**node-datachannel 的 polyfill RTCPeerConnection** 在构建 TURN URL 时将 username:credential 直接拼入 URL：

```
turn:USERNAME:CREDENTIAL@HOST:PORT?transport=udp
```

TURN REST API 的标准 username 格式为 `timestamp:identity`（如 `1775414573:145937910625`），包含冒号。拼接后变成：

```
turn:1775414573:145937910625:CREDENTIAL@edge.coclaw.net:3478
```

libdatachannel 的 URL parser 在第一个 `:` 处截断，只取 `1775414573` 作为 username。coturn 用截断的 username 计算 HMAC → 不匹配 → 认证失败。

**Bug 位置**：`node_modules/node-datachannel/dist/esm/polyfill/RTCPeerConnection.mjs` 约 63-72 行。

### 7.4 修复方案

在 `plugins/openclaw/src/webrtc/ndc-preloader.js` 中添加 `wrapNdcCredentials()` wrapper，在 RTCPeerConnection 构造前对 iceServers 的 username/credential 做 `encodeURIComponent()`：

```javascript
function wrapNdcCredentials(NativeRTC) {
    return class extends NativeRTC {
        constructor(config = {}) {
            if (config?.iceServers) {
                config = {
                    ...config,
                    iceServers: config.iceServers.map(s => {
                        if (!s.username && !s.credential) return s;
                        return {
                            ...s,
                            username: s.username ? encodeURIComponent(s.username) : s.username,
                            credential: s.credential ? encodeURIComponent(s.credential) : s.credential,
                        };
                    }),
                };
            }
            super(config);
        }
    };
}
```

### 7.5 为什么变更前正常

变更前 coturn 使用旧 IP (im.coclaw.net:3478)，TURN URL 格式相同，username 也含冒号。理论上同样的 bug 应该存在。可能的解释：
- 变更前 gateway 使用的是 werift（不受此 bug 影响），之后切换到了 ndc
- 或者变更前 P2P 直连成功（不依赖 TURN），变更后某些原因导致 P2P 失败被迫走 TURN
- **此点尚未完全确认，需要进一步验证**

### 7.6 验证结果

- Playwright 自动化测试通过 im.coclaw.net 成功建立 WebRTC：`ICE connected: local=host/udp, remote=host/udp (P2P)`
- 测试使用 test-001 账号，bot ID 145953942236
- DataChannel "rpc" 成功打开

## 8. 兼容性设计

### 8.1 默认模式 vs 双 IP 模式

不设置 `TURN_DOMAIN` 等新变量 → 行为完全不变（自部署用户零配置）。

### 8.2 旧版 plugin 兼容

- server 通过 `genTurnCredsForGateway()` 过滤 `turns:` URL 发给 gateway
- gateway 只收到 `turn:` URL，不会遇到 `turns:` 解析问题

### 8.3 三种部署形态

| 部署形态 | 需设置的变量 |
|---------|------------|
| 单主机单 IP（默认） | 仅现有变量 |
| 单主机双 IP | `NGINX_LISTEN_IP` + `TURN_DOMAIN` + `TURN_TLS_*` |
| 独立主机 coturn | `TURN_DOMAIN` + (可选 `TURN_TLS_*`) |

## 9. 待处理事项

- [ ] 确认 ndc credential encoding 修复在用户实际环境（非同机 Playwright）中有效
- [ ] 调查"变更前为何正常"的真实原因（werift vs ndc 切换时间点？）
- [ ] 决定 server/deploy 变更是否可以 commit（需用户确认修复效果）
- [ ] 考虑是否向 node-datachannel 上游报告此 bug
- [ ] `--aux-server` 的 TURN allocation 行为是否完全等价于 `--listening-ip`（调查 agent 确认可以，但建议长期关注）
- [ ] certbot-renew 容器化（当前用 root crontab，可改为 compose 服务）
- [ ] 清理 server 的 `genTurnCreds` 中多余的旧域名 URL（确认修复后可移除）
- [ ] deploy/CLAUDE.md 更新（反映新的配置项和目录结构）
