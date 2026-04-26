---
"@coclaw/ui": patch
---

fix(ui): only bump network baseline counter when normalized type written

The Capacitor network listener bumped `_networkEventCount` on every event,
including offline (`connected:false, type:'none'`) ones. That counter is also
the gate that decides whether a slow `Network.getStatus()` may write the
initial `_lastConnectionType` baseline. So the cold-boot sequence
"offline event → slow getStatus resolves wifi → real wifi→cellular switch"
ended with `_lastConnectionType` still null, the cellular event computed
`typeChanged=false`, and the store layer skipped the ICE restart that should
have fired. Move the counter bump inside the `connected && normalized` branch
so only baseline-writing events count, leaving offline events out of the way.
