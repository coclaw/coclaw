---
"@coclaw/ui": patch
---

Fix a horizontal scrollbar appearing in dropdown menus that contain separators (e.g. the desktop sidebar user account menu). The global menu theme zeroes the group's horizontal padding so highlights span the full row, which left Nuxt UI's default separator `-mx-1` with nothing to offset — pushing each divider 4px past both edges and tripping the menu viewport's implicit horizontal overflow. Neutralized with `separator: mx-0` so dividers sit flush to the viewport width.
