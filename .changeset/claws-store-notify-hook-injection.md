---
'@coclaw/ui': patch
---

refactor(ui): switch claws.store notify to hook injection to avoid dynamic import

Replace the lazy `import()` of `useNotify` / `i18n` inside `claws.store.js` with a small DI hook (`__registerNotifyHooks`) that mirrors the existing `__registerClawLifecycleHooks` pattern. The store no longer transitively pulls `@nuxt/ui/composables` — whose barrel exposes `#imports` (Node subpath imports) and breaks tests that don't load `@nuxt/ui/vite`. A new `notify-hook-bridge.js` is imported once at app startup to wire the real `useNotify().warning` and `i18n.global.t` implementations. No user-visible behavior change.
