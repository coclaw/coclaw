---
"@coclaw/server": patch
---

Render the per-entry timestamp on incoming remote-log (`type: 'log'`) packets as a `[ts=<ISO_UTC>]` field instead of the previous local-timezone `HH:mm:ss.SSS` rendering. The field is glued directly to the trailing `]` of the prefix block and separated from the message body by a single space, so the new shape is `[remote][plugin][claw:<id>][ts=2026-05-12T08:26:16.450Z] <text>` (the previous ` | ` separator is gone). Missing/invalid `ts` falls back to `[ts=??]` instead of `??:??:??.???`. Affects both `claw-ws-hub.js` (plugin path) and `rtc-signal-hub.js` (UI path). Plugin/UI clients are untouched — they still send the same `{ ts: number, text: string }` shape; only the server-side rendering changes. Rationale: docker `-t` (server receive ts) and the in-line client-emit ts are now both UTC and easy to extract with `\[ts=([0-9-]+T[0-9:.]+Z)\]`, so agents can sort cross-end log streams by event time in dictionary order without any timezone juggling.
