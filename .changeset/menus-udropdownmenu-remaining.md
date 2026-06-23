---
"@coclaw/ui": patch
---

Migrate the remaining two hand-built menus (DesktopSidebar user menu and ManageClawsPage claw action menu) from UPopover to UDropdownMenu, inheriting the global dropdown theme. This brings keyboard navigation, Esc-to-close and proper menu semantics for free, and removes the last duplicated hand-rolled popover lists. Behavior is preserved: the same items, click handlers, per-item disabled gating, danger styling, separators and E2E testids; the user menu still spans the sidebar width.
