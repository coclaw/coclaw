---
"@coclaw/ui": patch
---

Log send failures on both chat send paths (new-topic and established-chat) via `console.error` so remote troubleshooting can capture the error, and align the `InstanceOverview` channel-list wrapping with the shipped `ManageClawsPage` fix to avoid overflow on narrow screens.
