---
"@coclaw/ui": patch
---

fix(ui): web-agents merge now lets server unhide propagate cross-device

The previous `loadAll` merge took the max of local and server `hiddenAt`, which silently dropped a `null` returned by the server. If user A hid an agent on this device and user A (or another tab/device) later re-opened the same agent from the picker — the server cleared `hiddenAt` and pushed `lastClickedAt` — but this device kept the stale local `hiddenAt`, so the agent stayed hidden forever locally. Merge now picks the candidate hide time and drops it whenever it isn't strictly newer than the merged `lastClickedAt`, mirroring the server semantics that any click clears any prior hide.
