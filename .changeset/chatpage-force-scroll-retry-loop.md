---
"@coclaw/ui": patch
---

fix(ui): make ChatPage back-to-bottom button reliable on iOS 15 by retrying force scroll until stable (WebKit drops programmatic scrolls during momentum); suppress scroll-flag writes during the retry loop, yield to real user input, and stop swallowing forced scrolls while history pagination is in flight
