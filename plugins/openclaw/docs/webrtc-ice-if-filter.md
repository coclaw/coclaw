# Plugin 端 WebRTC ICE 候选 - 默认接口名黑名单

> 适用范围：`src/webrtc/webrtc-peer.js` 的 `pcConfig.settings.interfaceFilter` 默认值。
> 这一层由 pion-ipc `SetInterfaceFilter` 落地，按**接口名前缀**（而非 IP 段）过滤 ICE 候选枚举。
> 调研明细见 commit history + `tmp/default-filter-design--research.md`（临时档）。

## 用户红线

**宁可放过，绝不误杀**——误杀让 plugin 完全连不上 UI（致命），伪 pair 只触发 ICE restart（可恢复）。

必须兼容部署形态：Docker 容器 / VMware Guest / K8s pod / WSL2 / Hyper-V Guest / LXC/LXD / VirtualBox Guest / Parallels Guest / OpenWrt 类小众系统。

## 当前清单

```js
interfaceFilter: {
    denyPrefixes: ['docker0'],
}
```

**IP CIDR 黑名单（`ipFilter.denyCIDRs`）：默认空**——容器/VM 内 `eth0` 就是 10/8、172.16/12、192.168/16 私网段，IP 段 deny 必然击穿主路径。

## 唯一一条：`'docker0'`（Docker default bridge 接口名）

> 写完整名是约定俗成的字面值；底层仍是 `HasPrefix` 匹配——理论上会撞 `docker0_old` / `docker0-bak` 这类反常识手工命名（见下方"HasPrefix 无字界红线"）。

| 维度 | 证据 |
|---|---|
| 业界 | livekit `config-sample.yaml` 注释直接举例 `excludes: - docker0`（[upstream link](https://github.com/livekit/livekit/blob/master/config-sample.yaml)）|
| 容器视角 | Docker bridge mode 容器内 netns 看不到 `docker0`，端点叫 `eth0` |
| VM/Pod 视角 | VMware/VBox/Hyper-V/Parallels/LXC Guest 内看不到；K8s pod 内看不到 |
| host network 风险 | host network 容器同时能看到 host 真实物理网卡，filter `docker0` 不会让它失联 |
| WSL2 mirrored 风险 | mirrored 下 host `docker0` 会镜像到 WSL2，但 WSL2 主路径是镜像的物理网卡 |
| 大小写 | Go `strings.HasPrefix` 字节级严格 case-sensitive；docker daemon 写死小写 `docker0`，无 case 漏配风险 |
| 字界 | 完整名前缀 `docker0` 不撞 `docker_proxy`/`docker-veth`/`docker_gwbridge` 等衍生名；理论上撞 `docker0_old`/`docker0-bak` 这类反常识手工命名 |

## 拒绝纳入（含理由）

| 候选 | 拒绝理由 |
|---|---|
| `br-` | **OpenWrt/小众路由系统**用 `br-lan`/`br-wan` 作为唯一对外桥的边缘 case 会被命中；用户红线要求"绝不误杀"，此条放弃 |
| `veth` | host 侧 veth 一般无 IPv4，filter 不 filter 都不会产生 candidate（无收益） |
| `virbr` | libvirt 场景对 CoClaw plugin 用户极小众；业界无硬编码先例 |
| `lxdbr` / `lxcbr` | LXC/LXD bridge 场景对 plugin 极小众 |
| `flannel.` / `cni0` / `cali` / `weave` | K8s **node 上**的接口；plugin 跑 K8s node 而非 pod 场景极小众 |
| `vmnet` / `vboxnet` | 民间教程列、业界主流项目未列；macOS host plugin 通过 vmnet 跟 Guest 通讯虽罕见但合法 |
| `vEthernet ` | WSL2 mirrored mode 下镜像 host 接口可能成主路径——**已识别 P 风险** |
| `tun` / `tap` / `utun` / `wg` / `tailscale0` | VPN/overlay 主路径，HasPrefix 红线 |
| `en` / `eth0` / `enp` / `ens` | 物理/有线主接口前缀，HasPrefix 红线 |

### HasPrefix 无字界红线（重要）

pion-ipc 的 `denyPrefixes` 用 Go `strings.HasPrefix`：**case-sensitive、无字界、O(n*m)**。pion-ipc 已有保护拒绝空 prefix。误配示例：

- `'eth0'` → 同时杀 VLAN `eth0.100`
- `'utun1'` → 同时杀 `utun10/11/...`（macOS tailscale 第 10+ 条隧道）
- `'en'` → 同时杀 macOS `en0`(WiFi) + Linux `enp3s0`(有线)
- `'tap'` / `'tun'` / `'utun'` → 杀 VPN 通用前缀

新增 deny 项前必须核对：该前缀字面是否会撞任何"用户主路径"接口名。

## 业界做法概览

| 项目 | 默认接口名 filter | 默认 IP filter |
|---|---|---|
| pion/webrtc | 无（只提机制不背书策略） | 无 |
| livekit | 无（YAML `interfaces.excludes` 给运维） | 无（仅 `enable_loopback_candidate: false` 是硬默认） |
| go2rtc | 无 | **硬编码 `172.16.0.0/12`**（自家文档承认容器内致命） |
| jitsi/ice4j | `blocked-interfaces: []` 空 | `blocked-addresses: []` 空（且 `use-link-local: true`） |
| mediasoup | 不枚举接口（要求显式 `announcedAddress`） | 同上 |

**结论**：CoClaw 定位与 go2rtc 接近（必须 zero-config），但**不能照搬 IP CIDR 路线**（容器内致命）。走"极保守的接口名前缀 deny"——比 go2rtc 走得更稳，最终只留 `docker0` 一条业界有先例且全场景可证安全的项。

## 用户配置入口（v2 follow-up）

v1 硬编码这一条；如果未来用户报"我有边缘场景被这条误杀"或运维想加自定义 deny，再开放 plugin settings override。当前 YAGNI。

## 测试覆盖

`src/webrtc/webrtc-peer.test.js`：

- `pion impl ships only docker0 in interfaceFilter.denyPrefixes`：钉死清单
- `pion impl default denyPrefixes excludes red-line (VPN/physical/br-) prefixes`：红线测试——`br-` 也在红线里，未来误改这条直接破测试套件
