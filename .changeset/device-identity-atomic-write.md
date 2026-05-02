---
'@coclaw/openclaw-coclaw': patch
---

Fix: `loadOrCreateDeviceIdentity` switches to the new `atomicWriteFileSync` instead of bare `fs.writeFileSync`. A crash mid-write could previously truncate `device-identity.json`; on next startup the parse would fail and a fresh deviceId would be regenerated, invalidating all existing device bindings. The new sync atomic helper follows the standard tmp + rename + finally cleanup pattern.
