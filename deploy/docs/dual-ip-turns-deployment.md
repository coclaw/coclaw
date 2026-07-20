# 双 IP / TURNS 部署运维

> 适用范围：coturn 通过 TURNS（TLS on 443）穿透限制性网络时的主机网络层与证书运维。
> 方案背景（为何选双 IP、ICE 降级路径、风险回滚）见已归档设计稿 `docs/designs/turn-over-tls.md`；
> 变量语义见 `deploy/.env.example` 的「TURNS / 独立域名模式」段；启动逻辑见 `deploy/scripts/coturn-start.sh`。
> 本文只讲**环境无关的运维做法与踩坑**。示例 IP 用占位符，实际生产取值不在公开仓。

## 1. 为什么需要独立 IP / 独立主机

TURNS 让 coturn 在 443 端口用 TLS 包裹 TURN 流量，外观与普通 HTTPS 无异，能穿透只放行 443 的网络。但 nginx 已经占用了本机 443，两个服务不能共享同一个 IP 的 443。因此 coturn 必须有**自己的 443**，两种形态：

- **同主机双公网 IP**：主机挂两块网卡（或一块网卡两个 IP），nginx 绑主 IP、coturn 绑辅 IP，各自的 443 互不冲突。需要下面第 2 节的 OS 网络层配置。
- **独立主机**：coturn 单独一台机器，天然独占 443，不涉及双网卡与策略路由，跳过第 2 节。

单 IP 下也可用 nginx `stream` 模块按 SNI 分流 443，但会给所有 TURN 中继数据多加一跳、且 `stream`/`http` 双配置模型维护成本高，已否决（见设计稿）。

## 2. 同主机双网卡：策略路由（OS 层，环境无关范式）

### 2.1 原理：为什么必须做策略路由

主机默认只有一张路由表、一条默认路由（走主网卡）。辅网卡收到的入站包，其**回程**会按默认路由从主网卡发出——源 IP 是辅网卡、出口却是主网卡，形成**非对称路由**，被上游或安全组丢弃，表现为「辅 IP 的服务连不上」。

解法是**按源地址分流**：给辅网卡单独一张路由表，表内放辅网卡自己的默认路由；再加一条策略规则「源地址是辅网卡 IP 的包，查这张表」。这样从辅 IP 发出的包原路走辅网卡，回程对称。

### 2.2 netplan 结构范式

持久化到 netplan（Ubuntu/Debian 系）。文件名用大编号前缀确保后加载（如 `/etc/netplan/60-eth1.yaml`）：

```yaml
network:
  version: 2
  ethernets:
    eth1:                        # 辅网卡
      dhcp4: true
      dhcp4-overrides:
        use-routes: false        # 关键：不让 DHCP 往主表写默认路由（见 2.4 踩坑）
      routing-policy:
        - from: <IP_TURN>        # 辅网卡本机 IP（直通模式=公网 IP，NAT 模式=私网 IP）
          table: 1001            # 源自辅 IP 的包 → 查表 1001
      routes:
        - to: default
          via: <GW_TURN>         # 辅网卡所在子网网关
          table: 1001            # 默认路由只进 1001，不污染主表
```

- 表号（`1001`）任取一个未用的自定义号即可，主表（`main`）保持不动。
- `<IP_TURN>` 取辅网卡实际持有的地址：云厂商「EIP 网卡可见/直通」模式下网卡直接持有公网 IP，普通 NAT 模式下持有私网 IP（公网经云 NAT 映射）。
- 改完 `netplan apply` 生效；校验 `ip rule show`（应见 `from <IP_TURN> lookup 1001`）与 `ip route show table 1001`（应见 default via `<GW_TURN>`）。

### 2.3 禁用 cloud-init 的网络接管

云镜像常带 cloud-init，它会在每次启动时按自己的模板重写网络配置，覆盖上面的 netplan。落地前先禁用它对网络的接管：

```yaml
# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
network: {config: disabled}
```

否则重启后策略路由丢失、辅网卡回到非对称状态。

### 2.4 踩坑：DHCP 客户端抢默认路由

在辅网卡上跑 DHCP 时，dhclient 默认会往**主路由表**塞一条**无 metric 的默认路由**，它可能抢占主网卡原有的默认路由，导致主 IP 整个断网（含 SSH 断连）。这就是 2.2 里 `use-routes: false` 的原因——让 DHCP 只拿地址、不动路由，默认路由完全由 netplan 显式管理。

> 处置提示：真把主 IP 的默认路由冲掉后，主 IP 已 SSH 不进；需从辅 IP 的入口登入删掉多余默认路由再修 netplan。所以**双网卡都要预留可登录入口**，别只依赖主 IP。

### 2.5 防火墙 / 安全组

辅 IP 需放行：`443/TCP`（TURNS）、`3478/TCP+UDP`（STUN/TURN）、relay 端口池（默认 `50000-51000/UDP`）、`80/TCP`（certbot standalone ACME 验证，见第 3 节）。coturn 迁到辅 IP 后，主 IP 上的 3478 与 relay 端口规则可回收。

## 3. TLS 证书：certbot standalone（独立域名）

TURN 独立域名（示例 `edge.example.com`，解析到辅 IP）需要自己的证书。命名建议中性、避开 `turn.` / `stun.` / `webrtc.` 前缀，防启发式域名黑名单。

### 3.1 为什么用 standalone + `--network host`

不能复用 nginx 的 webroot 模式：容器端口映射 `-p <辅IP>:80:80` 的回程包会被 Docker NAT 后按主表路由走主网卡（非对称），Let's Encrypt 回连失败。改用 **standalone + `--network host`**——certbot 直接在主机网络栈绑 80，策略路由（2.2）对它生效，回程对称。

```bash
docker run --rm --network host \
  -v ./certbot/conf:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  --http-01-address <IP_TURN> \
  -d edge.example.com \
  --email <ops-email> --agree-tos --no-eff-email
```

`--http-01-address <IP_TURN>` 把 ACME 监听钉在辅 IP，避免和主 IP 上的 nginx 80 抢绑。

### 3.2 续期是独立于容器的一条路径

仓库内 `certbot-renew` 容器（`--profile auto-https`）走 webroot，只续**主域名**（`APP_DOMAIN`）的证书。TURN 独立域名的证书走上面的 standalone 路径，**不经过那个容器**，需单独安排续期（如主机 crontab 跑同样的 standalone 命令）。两条路径别混淆。

> `certbot renew` 无论是否真的续期都返回 0。若续期后无脑 `docker compose restart coturn`，会导致 coturn 被周期性白重启（每次重启短暂影响正在中继的用户）。正确做法：用 `--deploy-hook` 在**真的**换了证书时才写 marker，续期命令后再据 marker 决定是否重启，且用 `;` 而非 `&&` 让重启判断独立于 certbot 退出码。

### 3.3 证书目录权限（容器最小权限教训）

certbot 建的 `conf/` 目录树默认 `700`、root 所有。coturn 容器以 `nobody:nogroup`（uid 65534）运行，**读不到**证书 → TLS 起不来。需放开读权限：

```bash
chmod 755 certbot/conf certbot/conf/live certbot/conf/archive
chmod 644 certbot/conf/live/<turn-domain>/privkey.pem   # 私钥文件
```

这是「容器非 root 运行」与「certbot 默认收紧权限」撞车的通用坑，换任何以非特权用户跑、需读 letsencrypt 目录的容器都适用。别反向把容器改成 root 跑来图省事——放开目录读权限是更小的权限面。

## 4. coturn TURNS 启动注意

启动逻辑在 `deploy/scripts/coturn-start.sh`：设了 `TURN_TLS_PORT` 且证书文件存在才追加 `--tls-listening-port`/`--cert`/`--pkey`；`TURN_INTERNAL_IP` 未设时回退到 `TURN_EXTERNAL_IP`（EIP 直通、内外 IP 相同的场景）。几个环境无关的坑：

- **`--tls-listening-port` 会在所有 `--listening-ip` 上绑 TLS 端口**，不能按 IP 选择性启用。若某个 IP 的 443 已被别的服务（如 nginx）占用，coturn 会绑定失败进重试循环。规避：让 coturn 只绑真正提供 TLS 的那个 IP；确需在额外 IP 上只听 3478（不听 TLS），用 `--aux-server <IP>:3478`（`--aux-server` 只绑 `--listening-port`，不碰 TLS 端口）。
- **coturn 4.9.0 不支持 `--no-tlsv1_1`**：传了会报 `unrecognized option` 直接退出。只用 `--no-tlsv1`。
- **证书热更新需重启**：coturn 不感知证书文件变更，续期换证后要重启才加载新证。影响面在三类服务里最小——只波及正在走 TURN 中继的用户，P2P 直连用户无感，且 ICE 检测到 `failed` 会自动 restart、秒级恢复（重启时机的坑见 3.2）。

## 5. 相关 .env 变量与发布验收

变量语义与示例见 `deploy/.env.example`「TURNS / 独立域名模式」段（`TURN_DOMAIN`、`TURN_TLS_PORT`、`TURN_TLS_CERT`、`TURN_TLS_KEY`、`NGINX_LISTEN_IP` 等）。要点：

- **默认零配置不变**：不设 `TURN_DOMAIN` 等新变量时行为完全等同单 IP 模式，自部署用户不受影响。
- **同主机双 IP 需设 `NGINX_LISTEN_IP`**：把 nginx 端口映射钉到主 IP（compose 里 `"${NGINX_LISTEN_IP:-0.0.0.0}:443:443"`），腾出辅 IP 的 443 给 coturn；独立主机形态则不需要。

发布后验收（对齐 `deploy/AGENTS.md` 硬约束）：coturn 日志显示 TLS 证书加载成功、`/api/v1/turn/creds` 返回含 `turns:` 的 URL。
