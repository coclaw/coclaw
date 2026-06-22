---
"@coclaw/ui": patch
---

Mark the ManageClawsPage claw status dots as decorative (aria-hidden). In active connection states the status they convey by color is already shown as adjacent text (connLabel), so hiding the dots from assistive technology avoids redundant screen-reader announcements.
