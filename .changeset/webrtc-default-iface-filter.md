---
'@coclaw/openclaw-coclaw': minor
---

Apply a minimal default ICE interface filter on the pion path to reduce phantom
ICE pairs from local virtual bridges. The pion `pcConfig.settings` now ships
`interfaceFilter.denyPrefixes: ['docker0', 'br-']`, which match Docker's default
bridge and user-defined bridges by name only (both are invisible inside
container/VM/Pod netns, so they cannot misfire as a plugin's only path). IP CIDR
filtering stays off by default to avoid breaking deployments where the plugin
itself runs in a container/VM whose `eth0` lives in a 10/8, 172.16/12 or
192.168/16 range. Each list entry is anchored against industry practice and
container/VM visibility evidence; rationale and red-line prefixes that must NOT
be added later are recorded in `plugins/openclaw/docs/default-filter.md`.
