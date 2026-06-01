---
"@coclaw/ui": patch
---

Reset the copied-code state when the device-code OAuth step restarts. Previously `start()` cleared the displayed code and error but left `codeCopied` (and its 3s timer) untouched, so in the narrow flow of copy code → auth fails → retry within the 3s hint window, the fresh authorization code briefly rendered "copied" instead of the copy button. `start()` now resets `codeCopied` and clears the pending timer.
