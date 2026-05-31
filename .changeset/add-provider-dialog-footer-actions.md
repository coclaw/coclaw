---
"@coclaw/ui": patch
---

Move all action buttons in the add-provider dialog into the modal footer for consistent layout. Previously the method chooser, the "OAuth login not supported" notice, and the device-code login step rendered their back/cancel/retry buttons inline in the body while only the API-key step used a footer. Now every configure sub-state drives a single unified footer (the device-code step signals its phase up via `update:phase`, and the dialog hosts its cancel/back/retry). Single-button footers (back / cancel) use a solid button so the lone action has proper visual weight and right-aligns cleanly.
