---
"@coclaw/ui": patch
---

Migrate the topic/agent/web-agent item action menus and the narrow-screen "+" menu from hand-built popovers to Nuxt UI UDropdownMenu, gaining keyboard navigation, menu semantics and Escape-to-close. A global dropdownMenu theme keeps the existing mobile-first item sizing (44px touch targets), and the menus stay non-modal (no scroll lock) to match the previous popover behavior.
