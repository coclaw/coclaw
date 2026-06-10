---
"@coclaw/ui": patch
---

Fix the Electron shell never quitting via Cmd+Q, SIGTERM, the updater, or OS logout: those quit paths do not set `app.isQuitting`, so the minimize-to-tray close handler cancelled the whole quit by preventing the window close. A `before-quit` hook now marks every quit intent as a real quit before windows close. On-machine root-cause research disproved the earlier "main thread wedges in RTC teardown" theory — the process stayed fully responsive with the quit simply cancelled, independent of RTC state.
