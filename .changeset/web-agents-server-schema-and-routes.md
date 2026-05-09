---
"@coclaw/server": minor
---

feat(server): add Web Agent feature backend (schema, presets, repo/service/route, startup hook)

Introduces the backend side of the public-AI Web Agent entry point. New `WebAgent` and `WebAgentClick` Prisma models (with `User` reverse fields), a code-driven preset list (`web-agent.presets.js`), and a bidirectional `syncPresets` that runs before `app.listen` to keep the DB and the preset list aligned (preset removed from code → row deleted → click history cascaded). Adds `GET /api/v1/web-agents` (returns presets + the user's lastClickedAt) and `POST /api/v1/web-agents/:id/click` (per-user upsert of click count and lastClickedAt). The `:id` parameter is validated as a positive integer within the `UnsignedInt` range (1..4294967295). UI/MainList integration follows in subsequent commits.
