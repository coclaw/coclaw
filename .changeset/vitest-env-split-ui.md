---
'@coclaw/ui': patch
---

perf(ui): split vitest test environment per file to skip jsdom for pure-logic suites

Annotate 32 pure-logic test files (utils / validators / services / stores / composables that don't touch the DOM) with `// @vitest-environment node` so they skip jsdom initialization. Cumulative jsdom environment startup across workers drops from ~53s to ~30s, and `pnpm test` wall-clock drops by ~5s.

Side fix in `src/utils/platform.js`: replace bare top-level `window` reads with a `globalThis` fallback so the module can be imported in non-browser environments (test workers running under the node environment) without crashing. Production builds run under a browser where `window === globalThis`, so the runtime behavior is identical — this is purely a non-browser-import compatibility patch.

Also harden `vitest.setup.js`'s `localStorage` / `sessionStorage` cleanup with `typeof` guards so the shared setup doesn't throw under the node environment.
