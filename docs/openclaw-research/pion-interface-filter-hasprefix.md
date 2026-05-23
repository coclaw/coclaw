# pion-ipc 接口过滤：`HasPrefix` 黑名单的误杀红线

> 范围：CoClaw plugins/openclaw 引入 `pcConfig.settings.interfaceFilter` 默认黑名单时的避坑清单。
> 来源：2026-05-14 pion-ipc / pion-node interface filter 基础设施落地后的 deep-review。

## 机制

pion-ipc 在 `internal/rtc/settings.go:145-153` 的 `compileInterfaceFilter` 把 plugin 传入的 `denyPrefixes` 和 `allowPrefixes` 编译成接口过滤闭包。匹配规则是 **case-sensitive `strings.HasPrefix`**，**无字界**——任何配进 `denyPrefixes` 的字符串都会同时杀掉以它**开头**的所有接口名。

`allowPrefixes` 同理：白名单非空时只放过以白名单某项开头的接口。

协议层契约见 pion-ipc 仓库 `docs/ipc-protocol.md:108-130`。

## 红线（实战核对过的误杀）

| 想杀 | 直接写 prefix | 真实结果 |
|---|---|---|
| `eth0` 主网卡 | `"eth0"` | 同时杀 VLAN 子接口 `eth0.100` / `eth0.1001` 等 |
| `utun1`（macOS 第二条 VPN 隧道） | `"utun1"` | 同时杀 `utun10` / `utun11` / `utun12`……（第 10 条之后的隧道）。tailscale 在 macOS 用 `utun*`，禁了直接断 P2P。 |
| 仅以太网主接口 | `"en"` | 同时命中 macOS `en0`（WiFi）与 Linux `enp3s0`（有线主接口）——两个平台主路由直接断开 |
| OpenVPN tap 接口 | `"tap"` | OpenVPN 等 VPN 用 `tap0` / `tap1` 当合法接口，禁了断 VPN |
| 所有 tun 类隧道 | `"tun"` | VPN 通用前缀，杀掉用户活在用的所有 tun VPN |
| 所有 utun 类隧道 | `"utun"` | 同上：tailscale / 商业 VPN 都用 |

## 默认黑名单的设计原则

- **接口名前缀过滤要谨慎**：用户机器上的接口名分布无法穷举，任何"经验之选"都可能撞红线，因此内置默认必须限定在"命名约定窄、误杀面可解释"的少数前缀，绝大多数前缀过滤应留给用户显式配置，并在 plugin 配置 schema / 文档里强调本表的红线。
- 默认应优先开 **IP CIDR 黑名单**——这一层语义清晰、跨平台一致。社区共识可信的 CIDR：
  - `172.16.0.0/12`（go2rtc 等项目共识；覆盖 docker 默认 bridge 网段、kubernetes overlay 等不可能走真实 P2P 的内网）
- **CoClaw plugin 当前实践**：在 IP CIDR 方案落地前过渡性内置 `denyPrefixes:['docker0']` —— docker bridge 命名约定下用户接口名以 `docker0` 起头基本只可能是 docker 自家网卡，HasPrefix 误杀面可解释（最多牵连 `docker0.<n>` 等同样源自 docker 的子接口）。其它接口前缀（`eth0` / `utun1` / `en` 等本表列的红线）一律不进默认黑名单。

## 用 `allowPrefixes` 也要避坑

`allowPrefixes` 非空时是严白名单——非匹配项一律 deny。同样要明确覆盖 VPN / overlay 前缀，否则一刀切死用户的 tailnet 或商业 VPN。

实战建议：

- `allowPrefixes` 不建议作为"出厂默认"启用。
- 用户想用白名单时，文档示例要显式包含 `utun` / `tun` / `tap` / `tailscale` / `wg` 等常见 VPN 前缀。

## 关联代码 / commit

- pion-ipc `internal/rtc/settings.go:145-153` `compileInterfaceFilter`
- pion-ipc `docs/ipc-protocol.md:108-130` 协议层文档
- pion-ipc commits：`1303321` + `a952fb5`（filter 基础设施落地）

## 历史出处

2026-05-14 pion-ipc / pion-node filter 基础设施落地后的 deep-review；原 `plugins/openclaw/TODO.md` "Plugin 端默认黑名单调研：HasPrefix 误杀红线清单"条目，已并入本 doc 移除。
