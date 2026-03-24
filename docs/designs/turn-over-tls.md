# TURN over TLS on 443 实施方案

> 创建时间：2026-03-24
> 状态：待实施
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

**建议**：`relay.coclaw.net`（中性，不含 "turn"/"stun" 等协议关键词）

> 技术上域名可以任意选择，`edge.*`、`cdn.*`、`link.*` 等均可。避免 `turn.*`、`stun.*`、`webrtc.*` 等直接暴露用途的前缀。

DNS 配置：
- `im.coclaw.net` → IP1（不变）
- `relay.coclaw.net` → IP2（新增 A 记录）

## 五、ICE 降级路径

TURN creds API 返回多个 URL，ICE 框架按优先级自动尝试，无需应用层干预：

```
ICE 候选路径（自动，按优先级递减）：

1. host / srflx 直连（P2P）
   └── 成功 → 不需要 TURN，结束

2. turn:relay.coclaw.net:3478?transport=udp（常规 TURN UDP）
   └── 成功 → 最快的中继方式

3. turn:relay.coclaw.net:3478?transport=tcp（常规 TURN TCP）
   └── 成功 → UDP 被封但 3478 TCP 可达

4. turns:relay.coclaw.net:443?transport=tcp（TURN over TLS）★
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

### 7.1 nginx 443 绑定变更（高风险）

**现状**：nginx 监听 `0.0.0.0:443`（所有 IP）
**目标**：改为仅监听 IP1 内网地址

```nginx
# 变更前
listen 443 ssl;

# 变更后
listen <IP1_INTERNAL>:443 ssl;
```

**注意事项**：
- 必须修改**所有** `listen 443` 的位置（包括 default server block）
- 云主机 NAT 环境下使用 VPC 内网 IP，不是公网 IP
- 变更后立即验证 `https://im.coclaw.net` 可达性
- port 80 保持 `0.0.0.0`（两个 IP 都需要 ACME 验证）

### 7.2 nginx 新增 ACME server block

为 `relay.coclaw.net` 在 port 80 上新增 server block，仅处理 certbot ACME challenge：

```nginx
server {
    listen 80;
    server_name relay.coclaw.net;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 444;  # 拒绝其他请求
    }
}
```

### 7.3 证书签发

使用 certbot HTTP-01 验证为 `relay.coclaw.net` 签发证书：
- `relay.coclaw.net` 解析到 IP2
- IP2:80 由 nginx 处理（0.0.0.0:80 覆盖）
- certbot webroot 模式，与现有 `im.coclaw.net` 的证书管理流程一致

证书文件路径：`certbot/conf/live/relay.coclaw.net/`

### 7.4 coturn 配置变更

coturn 整体迁移到 IP2（`--listening-ip` 为全局设置，无法按端口绑定不同 IP）：

```yaml
coturn:
  command: >-
    turnserver
    --listening-port=${TURN_PORT:-3478}
    --tls-listening-port=443
    --listening-ip=${TURN_INTERNAL_IP}
    --relay-ip=${TURN_INTERNAL_IP}
    --external-ip=${TURN_EXTERNAL_IP}/${TURN_INTERNAL_IP}
    --cert=/etc/turn-certs/fullchain.pem
    --pkey=/etc/turn-certs/privkey.pem
    --realm=${TURN_DOMAIN}
    --lt-cred-mech
    --use-auth-secret
    --static-auth-secret=${TURN_SECRET}
    --min-port=${TURN_MIN_PORT:-50000}
    --max-port=${TURN_MAX_PORT:-51000}
    --fingerprint
    --no-cli
    --log-file=stdout
```

新增/变更项：
- `--tls-listening-port=443`：TLS 监听
- `--cert` / `--pkey`：TLS 证书路径
- `--realm`：改为 `TURN_DOMAIN`（`relay.coclaw.net`）
- `TURN_INTERNAL_IP` / `TURN_EXTERNAL_IP`：改为 IP2 的内网/公网地址

### 7.5 证书热更新

coturn 不会自动感知证书文件变更。需要 certbot deploy hook 触发重载：

```bash
# certbot renew deploy hook
docker compose restart coturn
```

coturn 重启影响较小：
- 仅影响正在使用 TURN 中继的用户（P2P 直连用户不受影响）
- ICE 层检测到 `failed` 后自动触发 ICE restart，秒级恢复

### 7.6 TURN creds API 变更

`server/src/routes/turn.route.js` 中 `genTurnCreds` 返回的 URLs 需更新：

```javascript
// 变更前
const domain = process.env.APP_DOMAIN;  // im.coclaw.net
urls: [
  `stun:${domain}:${port}`,
  `turn:${domain}:${port}?transport=udp`,
  `turn:${domain}:${port}?transport=tcp`,
]

// 变更后
const turnDomain = process.env.TURN_DOMAIN;  // relay.coclaw.net
urls: [
  `stun:${turnDomain}:${port}`,
  `turn:${turnDomain}:${port}?transport=udp`,
  `turn:${turnDomain}:${port}?transport=tcp`,
  `turns:${turnDomain}:443?transport=tcp`,
]
```

新增环境变量 `TURN_DOMAIN`，独立于 `APP_DOMAIN`。

### 7.7 环境变量变更

| 变量 | 变更 | 说明 |
|------|------|------|
| `TURN_DOMAIN` | **新增** | coturn 独立域名（如 `relay.coclaw.net`） |
| `TURN_EXTERNAL_IP` | **值变更** | 改为 IP2 公网地址 |
| `TURN_INTERNAL_IP` | **值变更** | 改为 IP2 VPC 内网地址 |
| `TURN_SECRET` | 不变 | |
| `TURN_PORT` | 不变 | 3478 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | 不变 | 50000-51000 |

## 八、防火墙规则

### IP2 新规则

| 端口 | 协议 | 防火墙 label | 说明 |
|------|------|-------------|------|
| 80 | TCP | `certbot ACME (relay)` | 证书签发验证 |
| 443 | TCP | `coturn TLS (TURNS)` | TURN over TLS，最终兜底 |
| 3478 | TCP + UDP | `coturn listening (STUN/TURN)` | 常规 STUN/TURN |
| 50000-51000 | UDP | `coturn relay pool` | 中继端口池 |

### IP1 规则清理

coturn 迁移到 IP2 后，IP1 上的 3478 和 50000-51000 规则应移除。

## 九、实施步骤

变更涉及多个环节，分步执行并逐步验证，确保每一步可回滚。

### Step 1：准备（不影响线上）

- [ ] 分配第二个公网 IP，确认对应的 VPC 内网 IP
- [ ] 确定 TURN 域名（如 `relay.coclaw.net`）
- [ ] DNS 添加 A 记录：`relay.coclaw.net` → IP2
- [ ] 等待 DNS 生效（`dig relay.coclaw.net` 验证）

### Step 2：证书签发（低风险）

- [ ] nginx 新增 `relay.coclaw.net` 的 port 80 server block（仅 ACME）
- [ ] reload nginx
- [ ] 为 `relay.coclaw.net` 签发证书
- [ ] 验证证书文件存在

### Step 3：nginx 443 绑定变更（高风险，需立即验证）

- [ ] 将所有 `listen 443` 改为 `listen <IP1_INTERNAL>:443`
- [ ] `nginx -t` 验证配置语法
- [ ] reload nginx
- [ ] **立即验证** `https://im.coclaw.net` 可达
- [ ] 若失败，立即回滚

### Step 4：IP2 防火墙（低风险）

- [ ] 开放 IP2 的 80/443/3478/50000-51000

### Step 5：coturn 迁移到 IP2 + 启用 TLS（中风险）

- [ ] 更新 `.env`：`TURN_DOMAIN`、`TURN_EXTERNAL_IP`、`TURN_INTERNAL_IP` 改为 IP2
- [ ] 更新 `compose.yaml`：coturn command 增加 TLS 配置、证书挂载
- [ ] `docker compose up -d coturn`
- [ ] 验证 coturn 日志无报错
- [ ] 验证 3478 可达：`turnutils_uclient -t relay.coclaw.net`（若有工具）

### Step 6：API 变更 + 部署（中风险）

- [ ] 更新 `turn.route.js`：URLs 改用 `TURN_DOMAIN`，新增 `turns:` URL
- [ ] 更新 server `.env`：新增 `TURN_DOMAIN`
- [ ] 部署 server
- [ ] 验证 `/api/v1/turn/creds` 返回正确 URLs

### Step 7：端到端验证

- [ ] 正常网络：RTC 建连成功，观察 candidate 类型
- [ ] 模拟 3478 封禁：仅保留 443，验证 TURNS 兜底生效
- [ ] 验证证书续期 hook 工作正常

### Step 8：清理

- [ ] 移除 IP1 上 3478/50000-51000 的防火墙规则
- [ ] 更新部署文档（deploy/CLAUDE.md、.env.example 等）
- [ ] 更新设计文档状态

## 十、coturn 重启影响评估

| 场景 | 影响范围 | 恢复方式 | 恢复时间 |
|------|---------|---------|---------|
| coturn 重启 | 仅 TURN 中继用户 | ICE restart 自动恢复 | 秒级 |
| nginx 重启 | 所有 HTTPS + WS 用户 | WS 自动重连 | 秒级 |
| server 重启 | 所有 WS + API 用户 | WS 自动重连 | 秒级 |

coturn 重启是三者中影响最小的——P2P 直连用户完全无感。

## 十一、风险与回滚

| 步骤 | 风险 | 回滚方式 |
|------|------|---------|
| nginx 443 绑定 | HTTPS 不可达 | 恢复 `listen 443 ssl`，reload |
| coturn 迁移 IP2 | TURN 不通 | 恢复旧 `.env`，`docker compose up -d coturn` |
| API URLs 变更 | 客户端拿到错误 URL | 恢复旧 `turn.route.js`，重启 server |
