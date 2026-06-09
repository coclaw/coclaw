---
"@coclaw/ui": patch
---

Fix the Electron desktop shell failing to quit from the tray menu. A graceful `app.quit()` delegates window teardown to the renderer's unload, which a remote page's `beforeunload` or an active WebRTC connection can cancel or stall — leaving the app alive with the tray still present. A quit guard now sets `app.isQuitting` from `before-quit` (so every quit entry point — tray, Cmd+Q, the app menu, and the updater — is treated as a real quit rather than minimized to the tray) and arms a watchdog that force-exits if a graceful quit does not complete in time, guaranteeing the app always exits. When the window closes cleanly the process exits first and the watchdog never fires.
