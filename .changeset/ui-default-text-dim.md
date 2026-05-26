---
'@coclaw/ui': patch
---

fix(ui): dim default text to text-default instead of highlighted white

Several container roots (the authed app layout, login/register pages, the
desktop sidebar) carried `text-highlighted`, which made every descendant
without an explicit color render as pure white in dark mode. Remove it so text
falls back to the body default (`--ui-text` / `text-default`).

Also override the global Nuxt UI theme so dialog titles and input / textarea /
select text use `text-default` (with `!` to win over the built-in
`text-highlighted`, which tailwind-merge does not dedupe against Nuxt UI's
semantic color utilities).
