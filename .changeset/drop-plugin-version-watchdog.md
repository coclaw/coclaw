---
'@coclaw/ui': patch
---

Stop spurious "plugin outdated" toast on first message in a new topic. The previous design re-probed `coclaw.info` after RTC reconnect to re-confirm the plugin version, but a transient RPC reject (timeout / DC blip) was conflated with "plugin too old" and pinned the version flag with no recovery path. The watchdog is removed entirely; plugin version is now read from the `coclaw.info.updated` event the plugin already pushes, plus a best-effort `coclaw.info` fetch in `__fullInit` as a startup baseline (failures never alter `pluginInfo`).
