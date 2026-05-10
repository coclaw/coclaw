---
"@coclaw/server": minor
---

feat(server): support hiding a Web Agent from the user's recent list

Adds the backend half of the "remove from recent" action on MainList Web Agents. New nullable `hiddenAt` column on `WebAgentClick` (NULL = not hidden), exposed on the existing `GET /api/v1/web-agents` payload. New endpoint `POST /api/v1/web-agents/:id/hide` flips `hiddenAt` to now via `updateMany` (no-op + 404 when the user has never clicked the agent, so a hide for a never-clicked entry will not silently materialise a click row). The existing `POST /:id/click` upsert now also clears `hiddenAt` on the update branch, so re-clicking an agent automatically un-hides it without a separate request. Repeat hides are idempotent. Existing `WebAgentClick` rows are unaffected by the migration (column is nullable with no default backfill).
