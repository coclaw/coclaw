---
"@coclaw/ui": patch
---

Show the "Reconnecting…" status banner on the chat/topic page during an ICE-restart recovery window (rtcPhase==='restarting'), where the DataChannel stays alive (dcReady remains true) so the existing dcReady guard previously left the page with no connection-recovery signal. Display-only; reuses the existing connRecovering copy and does not touch the RTC state machine or the send path.
