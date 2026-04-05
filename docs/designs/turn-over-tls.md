# TURN over TLS on 443 实施方案

> 创建时间：2026-03-24
> 最后更新：2026-04-05
> 状态：已实施（2026-04-05）
> 前置依赖：WebRTC P2P 数据通道 Phase 1 & 2 已完成（见 `webrtc-p2p-channel.md`）
> 对应阶段：`webrtc-p2p-channel.md` Phase 4

---

## 一、目标

将 TURN 流量通过 TLS 包裹后在 443 端口传输，使其在网络层面与普通 HTTPS 流量无法区分，穿透绝大多数限制性网络环境。

## 二、背景与动机

当前 TURN 监听在 3478 端口（UDP + TCP）。存在以下局限：

- **非标准端口**：部分企业网络仅放行 80/443
- **协议特征明显**：STUN/TURN 的 magic cookie（`0x2112A442`）可被 DPI 设备识别并阻断
- **3478 TCP 不足以应对**：虽然 TCP 降级可穿透部分 UDP 封禁环境，但端口本身仍可能被封

TURN over TLS on 443 后：
- 外观与 HTTPS 完全一致（TLS 握手 + 443 端口）
- DPI 仅能看到 TLS 加密流量，无法识别内层 TURN 协议
- 443 出站几乎不会被封禁

## 三、方案选型

### 3.1 单 IP + nginx stream SNI 路由（已否决）

原始设计思路：nginx `stream` 模块监听 443，通过 SNI preread 将流量分发到 nginx http（Web）或 coturn（TURN）。

```
nginx stream (:443) → SNI preread → im.coclaw.net  → nginx http
                                   → turn域名       → coturn TLS
```

**否决原因**：
- nginx 需同时加载 `http` + `stream` 模块，配置复杂度高
- 所有 TURN 中继数据经 nginx TCP 代理多一跳
- `stream` 模块配置与现有 `http` 模块配置模型差异大，维护成本高

### 3.2 双公网 IP（采纳）

为主机分配第二个公网 IP，nginx 和 coturn 各绑定自己的 IP，443 端口互不冲突。

```
IP1 (Web)                          IP2 (TURN)
  │                                  │
  ├── :80  nginx (ACME + redirect)   ├── :80  nginx (ACME only)
  ├── :443 nginx (HTTPS)             ├── :443 coturn TLS (TURNS)
  │                                  ├── :3478 coturn (STUN/TURN)
  │                                  └── :50000-51000 coturn relay pool
```

**优势**：
- 无端口冲突，无需 nginx stream
- TURN 数据直达 coturn，无额外跳数
- 架构清晰，各服务物理隔离

## 四、域名规划

需要一个独立子域名指向 IP2。域名选择应避免暴露 TURN 用途（防止启发式域名黑名单）。

**实际选用**：`edge.coclaw.net`（中性，不含 "turn"/"stun" 等协议关键词）

> 技术上域名可以任意选择，`edge.*`、`cdn.*`、`link.*` 等均可。避免 `turn.*`、`stun.*`、`webrtc.*` 等直接暴露用途的前缀。

DNS 配置：
- `im.coclaw.net` → IP1（不变）
- `edge.coclaw.net` → IP2（新增 A 记录）

## 五、ICE 降级路径

TURN creds API 返回多个 URL，ICE 框架按优先级自动尝试，无需应用层干预：

```
ICE 候选路径（自动，按优先级递减）：

1. host / srflx 直连（P2P）
   └── 成功 → 不需要 TURN，结束

2. turn:edge.coclaw.net:3478?transport=udp（常规 TURN UDP）
   └── 成功 → 最快的中继方式

3. turn:edge.coclaw.net:3478?transport=tcp（常规 TURN TCP）
   └── 成功 → UDP 被封但 3478 TCP 可达

4. turns:edge.coclaw.net:443?transport=tcp（TURN over TLS）★
   └── 成功 → 最终兜底，伪装为 HTTPS
   └── 失败 → RTC 建连失败，降级到 WS
```

**关键**：第 4 级是本方案新增的。对应用层完全透明——只是多一个 relay candidate，优先级最低。

## 六、覆盖范围

| 网络环境 | P2P | TURN 3478 | TURNS 443 | 最终结果 |
|----------|-----|-----------|-----------|---------|
| 普通家庭/办公 | ✅ | — | — | P2P 直连 |
| 限制性办公（对称 NAT） | ❌ | ✅ | — | TURN UDP 中继 |
| 封禁非标端口 | ❌ | ❌ | ✅ | TURN over TLS |
| 仅白名单域名出站 | ❌ | ❌ | ❌ | 失败（WS 同样不可用） |
| MITM 代理 | ❌ | ❌ | ❌ | 失败（WS 同样不可用） |

后两种场景中 WS 大概率也不可用，因此 **RTC 不可用 ≈ WS 不可用**，印证了 WS-only 模式禁用文件发送的决策（见 `webrtc-p2p-channel.md` 第七节）。

## 七、实施细节

> 以下反映实际实施结果。与原方案的偏差以"**实际**"标注。

### 7.1 nginx 443 绑定变更

**实际**：未修改 nginx 配置文件，改为在 compose 层通过 `NGINX_LISTEN_IP` 控制端口映射：

```yaml
# compose.yaml
ports:
  - "${NGINX_LISTEN_IP:-0.0.0.0}:80:80"
  - "${NGINX_LISTEN_IP:-0.0.0.0}:443:443"
```

不设置 `NGINX_LISTEN_IP` 时行为不变（绑定所有 IP）。仅同主机双 IP 场景需设置为主网卡内网 IP。

### 7.2 TURN 域名证书签发

**实际**：未使用 nginx webroot 模式，改用 certbot standalone + `--network host`：

```bash
docker run --rm --network host \
  -v ./certbot/conf:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  --http-01-address <IP2> \
  -d edge.coclaw.net \
  --email ops@coclaw.net --agree-tos --no-eff-email
```

原因：Docker 端口映射 `-p <IP2>:80:80` 会导致回程路由走主网卡（非对称路由），策略路由不生效。`--network host` 直接使用主机网络栈，策略路由正常。

证书续期通过 root crontab 执行（同样使用 standalone + --network host）。

**证书目录权限**：certbot 默认创建 700 权限目录，coturn 以 nobody (65534) 运行无法读取。需手动 `chmod 755` conf/live/archive 目录，`chmod 644` privkey 文件。

### 7.3 coturn 配置

**实际**：改为动态启动脚本 `deploy/scripts/coturn-start.sh`，替代 compose 内联 command：

```yaml
coturn:
  entrypoint: ["/bin/sh", "/scripts/coturn-start.sh"]
  environment:
    TURN_PORT, TURN_INTERNAL_IP, TURN_EXTERNAL_IP, TURN_SECRET,
    TURN_MIN_PORT, TURN_MAX_PORT, TURN_TLS_PORT, TURN_TLS_CERT,
    TURN_TLS_KEY, APP_DOMAIN
  volumes:
    - ./scripts/coturn-start.sh:/scripts/coturn-start.sh:ro
    - ./certbot/conf:/etc/letsencrypt:ro
```

脚本根据环境变量条件启用 TLS：`TURN_TLS_PORT` 已设置且证书文件存在时才添加 `--tls-listening-port`。

`TURN_INTERNAL_IP` 未设置时自动回退到 `TURN_EXTERNAL_IP`（适用于 EIP 直通模式，内外 IP 相同）。

### 7.4 证书热更新

coturn 不会自动感知证书文件变更。当前通过 root crontab 的 certbot renew `--deploy-hook` 触发 `docker compose restart coturn`。

coturn 重启影响较小：
- 仅影响正在使用 TURN 中继的用户（P2P 直连用户不受影响）
- ICE 层检测到 `failed` 后自动触发 ICE restart，秒级恢复

### 7.5 TURN creds API 变更

`server/src/routes/turn.route.js` 中 `genTurnCreds` 返回的 URLs：

```javascript
const turnDomain = process.env.TURN_DOMAIN || process.env.APP_DOMAIN;
const tlsPort = process.env.TURN_TLS_PORT;
urls: [
  `turn:${turnDomain}:${port}?transport=udp`,
  `turn:${turnDomain}:${port}?transport=tcp`,
  // 仅 TURN_TLS_PORT 已设置时追加
  `turns:${turnDomain}:${tlsPort}?transport=tcp`,
]
```

**实际**：移除了原方案中的 `stun:` URL（浏览器和 ndc 均可通过 TURN URL 自动获取 STUN 能力）。

`genTurnCredsForGateway()` 过滤掉 `turns:` URL 发给 gateway/plugin（旧版不支持 `turns:` scheme）。此为临时兼容，标注 2026-04-12 后移除。

### 7.6 环境变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `TURN_DOMAIN` | 新增，可选 | coturn 独立域名，未设置回退到 `APP_DOMAIN` |
| `TURN_TLS_PORT` | 新增，可选 | TURNS 监听端口，设置后启用 TLS |
| `TURN_TLS_CERT` | 新增，可选 | TLS 证书路径（coturn 容器内） |
| `TURN_TLS_KEY` | 新增，可选 | TLS 私钥路径（coturn 容器内） |
| `NGINX_LISTEN_IP` | 新增，可选 | 同主机双 IP 时 nginx 绑定的 IP，默认 `0.0.0.0` |
| `TURN_EXTERNAL_IP` | 值变更 | 改为 IP2 公网地址 |
| `TURN_INTERNAL_IP` | 值变更 | 改为 IP2 内网地址（EIP 直通时可省略） |

## 八、防火墙规则

### IP2 规则

| 端口 | 协议 | 说明 |
|------|------|------|
| 80 | TCP | certbot ACME 验证（standalone） |
| 443 | TCP | coturn TLS (TURNS) |
| 3478 | TCP + UDP | coturn (STUN/TURN) |
| 50000-51000 | UDP | coturn relay 端口池 |

### IP1 规则清理

coturn 迁移到 IP2 后，IP1 上的 3478 和 50000-51000 规则应移除。

## 九、实施检查清单

> 已于 2026-04-05 完成。

- [x] 分配第二个公网 IP（阿里云辅助 ENI + EIP 网卡可见模式）
- [x] OS 策略路由配置（netplan + table 1001）
- [x] DNS A 记录：`edge.coclaw.net` → IP2
- [x] 防火墙规则开放 IP2 端口
- [x] 证书签发（certbot standalone --network host）
- [x] 证书目录权限调整（chmod 755/644）
- [x] compose.yaml 更新（nginx 端口、server env、coturn 脚本化）
- [x] coturn-start.sh 编写
- [x] .env 更新
- [x] server turn.route.js 更新（TURN_DOMAIN + TURNS URL + gateway 兼容）
- [x] server 镜像构建 + 部署（0.8.1）
- [x] 端到端验证：WebRTC 经 TURN relay 连接成功
- [x] 部署文档更新

## 十、踩坑记录

### 10.1 策略路由与 Docker 端口映射

双网卡主机上，Docker `-p <IP2>:80:80` 端口映射的回程包仍走默认路由（主网卡），导致非对称路由。策略路由 `from <IP2>` 规则仅对从 IP2 直接发出的包生效，不覆盖 Docker NAT 后的包。

**解决**：需要绑定 IP2 端口的容器使用 `--network host`，直接在主机网络栈操作。

### 10.2 coturn 4.9.0 的 --no-tlsv1_1

coturn 4.9.0（当前 Docker latest）不支持 `--no-tlsv1_1` 选项，启动时报 unrecognized option 并退出。仅 `--no-tlsv1` 可用。

### 10.3 coturn --tls-listening-port 绑定所有 listening-ip

`--tls-listening-port` 会在所有 `--listening-ip` 上绑定 TLS 端口，无法按 IP 选择性启用。若需要某些 IP 只监听 3478 而不监听 TLS 端口，应使用 `--aux-server` 添加这些 IP（`--aux-server` 只绑定 `--listening-port`，不绑定 TLS 端口）。当前方案中 coturn 仅绑定一个 IP（edge），不存在此问题。

### 10.4 certbot 证书目录权限

certbot 创建的 `conf/` 目录树默认 700 权限（root 所有）。coturn 容器以 nobody:nogroup (65534) 运行，无法读取证书文件。需要手动调整：

```bash
chmod 755 certbot/conf certbot/conf/live certbot/conf/archive
chmod 644 certbot/conf/live/edge.coclaw.net/privkey.pem  # 或对应的实际文件
```

### 10.5 node-datachannel URL 编码 bug

node-datachannel polyfill 的 `RTCPeerConnection` 将 username:credential 直接拼入 TURN URL 字符串。TURN REST API 标准的 username 格式为 `timestamp:identity`（含冒号），拼接后 URL parser 在冒号处截断，导致 coturn 只收到时间戳部分，HMAC 校验必然失败。

**修复**：在 plugin 侧包装 `RTCPeerConnection`，构造前对 iceServers 的 username/credential 做 `encodeURIComponent()`。浏览器端不受影响（使用结构化参数而非 URL 拼接）。

此 bug 与双 IP 部署无关，但在部署过程中被发现。详见 plugin `ndc-preloader.js` 中的 `wrapNdcCredentials()`。

## 十一、coturn 重启影响评估

| 场景 | 影响范围 | 恢复方式 | 恢复时间 |
|------|---------|---------|---------|
| coturn 重启 | 仅 TURN 中继用户 | ICE restart 自动恢复 | 秒级 |
| nginx 重启 | 所有 HTTPS + WS 用户 | WS 自动重连 | 秒级 |
| server 重启 | 所有 WS + API 用户 | WS 自动重连 | 秒级 |

coturn 重启是三者中影响最小的——P2P 直连用户完全无感。

## 十二、风险与回滚

| 步骤 | 风险 | 回滚方式 |
|------|------|---------|
| nginx 端口绑定 | HTTPS 不可达 | 移除 `NGINX_LISTEN_IP`，重启 nginx |
| coturn 迁移 IP2 | TURN 不通 | 恢复旧 `.env`，`docker compose up -d coturn` |
| API URLs 变更 | 客户端拿到错误 URL | 移除 `TURN_DOMAIN`/`TURN_TLS_PORT`，重启 server |
