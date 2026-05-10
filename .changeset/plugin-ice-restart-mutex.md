---
"@coclaw/openclaw-coclaw": patch
---

Fix concurrent ICE restart offer race causing user-facing "Agent run failed" notifications. The plugin now serializes per-connId offer handling with a mutex so multiple near-simultaneous restart offers from the UI run sequentially (last-write-wins), avoiding the pion `InvalidModificationError` that previously triggered an over-eager session teardown. The ICE restart success path additionally re-checks session identity after each await so close-during-lock paths (rtc:closed / connectionState transitions / closeAll) abort silently instead of emitting a stale answer or restart-rejected.
