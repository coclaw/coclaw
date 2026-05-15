---
'@coclaw/openclaw-coclaw': minor
---

Apply a minimal default ICE interface filter on the pion path to reduce phantom
ICE pairs from local virtual bridges. The pion `pcConfig.settings` now ships
`interfaceFilter.denyPrefixes: ['docker0']`, matching Docker's default bridge by
its fixed lowercase name. The match is byte-level case-sensitive (Go
`strings.HasPrefix`); docker daemon hardcodes `docker0` lowercase, so there is
no case-mismatch risk. The prefix is invisible from inside container/VM/Pod
netns (Docker bridge containers see `eth0` instead; WSL2 mirrored still has the
physical NIC mirrored alongside; all hypervisor Guests cannot see host bridges),
so it cannot misfire as a plugin's only path.

Docker user-defined bridges (`br-XXXX`) and the `'br-'` prefix were considered
but rejected: OpenWrt-style systems may use `br-lan` as the only outbound
interface, and the user red line forbids any chance of breaking that. IP CIDR
filtering also stays off by default — container/VM eth0 lives in private ranges
(10/8, 172.16/12, 192.168/16), so any IP-segment deny would break those
deployments (this is exactly the failure mode go2rtc admits to in its docs).

Red-line prefixes that must NEVER enter this list (including `'br-'`) are
encoded as an explicit test so future contributors cannot regress without
breaking the suite. Rationale, industry references and rejection reasons for
each near-miss candidate are recorded in
`plugins/openclaw/docs/webrtc-ice-if-filter.md`.
