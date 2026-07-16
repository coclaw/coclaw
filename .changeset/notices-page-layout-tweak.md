---
"@coclaw/ui": patch
---

Refine the Open Source Notices page layout: align its top/bottom padding with the Add Claw page, shrink the wide-screen heading to 1rem, and on md-and-below screens (where the sidebar narrows the content area) shorten the notice text's fixed-width decorative separator lines (full rows of `=` or `-`) to 30 characters so they no longer overflow and wrap into ragged remnants. lg-and-up screens keep the original separators, and the render-time transform leaves all other body text untouched (the generator and public/third-party-notices.txt are not modified).
