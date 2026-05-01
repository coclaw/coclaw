---
'@coclaw/ui': patch
---

refactor(ui): replace dynamic `import('./platform.js')` in `saveBlobToFile` with a static top-level import

`utils/platform.js` only reads window globals and has no platform-conditional dependency to defer, so the dynamic import was a leftover style. Aligns with the workspace rule of avoiding dynamic `import()` (capacitor/electron conditional loading remains the only exception). Tests switch from `vi.doMock` + dynamic import to a hoisted state object + getter mock so `isCapacitorApp` can still flip per case. No user-visible behavior change.
