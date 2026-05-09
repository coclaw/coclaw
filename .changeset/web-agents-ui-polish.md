---
"@coclaw/ui": patch
---

fix(ui): polish Web Agent UI — official brand icons, hover cursor, vendor labels, layout tweaks

- Use each product's official brand icon (Doubao avatar / Qwen sparkle / Yuanbao green-circle / Kimi dark square) sourced from each vendor's homepage favicons; DeepSeek keeps its existing SVG. Asset glob now accepts both `.svg` and `.png` so PNG-only brands can ship at-source; SVG wins when both formats exist for the same slug.
- Lock the Web Agent label to "Web Agent" across all 12 locales (no translation).
- Add `cursor-pointer` to MainList claw/agent/topic/web-agent rows and to picker dialog items so hover feedback is consistent.
- Merge the standalone Web Agent entry button into the recent web-agents nav as its first item; one section instead of two.
- Tint the Web Agent entry's globe icon to `text-teal-500`, matching the CoClaw logo line color (was `text-dimmed`).
- Tighten picker item left/right padding via `-mx-3` so the icon's first character aligns vertically with the dialog title.
- Tighten picker dialog body vertical padding to `pt-3 pb-4` (was `p-4 sm:p-6`); on mobile the bottom uses `max(1rem, env(safe-area-inset-bottom))` so the home-indicator clearance is preserved without losing the desktop floor. The `sm:` breakpoint is overridden explicitly so Nuxt UI's default `sm:p-6` cannot reintroduce extra padding above 640px width.
- Show the vendor name (e.g. 深度求索 / ByteDance) on the right side of each picker item; vendor span uses `min-w-0 truncate` so it also participates in truncation when both the agent name and vendor are long, instead of forcing the agent name to absorb all the shrinkage.
