---
"@coclaw/ui": patch
---

Tighten the electron-builder file whitelist to the desktop shell's runtime dependency closure. The Electron build loads the hosted frontend at runtime, so the ui production dependency tree and its build tools (tailwind/esbuild/rollup/sass and their native variants) are never referenced by the shell. Exclude the whole node_modules tree and re-include only the shell main-process runtime closure, dropping cross-platform native variants, build tools, and peer supersets from app.asar.
