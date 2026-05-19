---
'@coclaw/openclaw-coclaw': patch
---

Fix `coclaw.sessions.getById`: include `.deleted` archives in fallback and lift the silent 500-message cap.

When the live `<sid>.jsonl` file is missing, the manager now scans both
`<sid>.jsonl.reset.<iso-ts>` and `<sid>.jsonl.deleted.<iso-ts>` archives and
picks the one with the latest archive timestamp (OpenClaw's ISO
`YYYY-MM-DDTHH-MM-SS[.sss]Z` format — same `(?:\.\d{3})?` pattern as
`artifacts.ts ARCHIVE_TIMESTAMP_RE` — guarantees lexicographic order = time order).
Previously only `.reset.*` was scanned, so sessions whose only archive was a
`.deleted.*` file (13 such sessions observed locally) returned an empty
transcript via this RPC.

`getById` also no longer clamps `params.limit` to a `[1, 500]` range with a
default of 500. The two UI callsites do not pass `limit`, and silently
truncating a long session to the last 500 messages dropped earlier turns
without any signal to the caller. New semantics:

- `limit` omitted / `null` / non-`number` type (string, boolean, array, object) /
  `NaN` / `Infinity` / `< 1` → return all messages
- `limit >= 1` (finite number) → return the last `Math.trunc(limit)` messages
  (so `2.9 → 2`, `1 → 1`; `0.5` is treated as "no limit" rather than
  `slice(-0)` which would silently return everything)

Strict `typeof === 'number'` is enforced to keep `Number('42') === 42`,
`Number(true) === 1`, `Number([5]) === 5` from being silently accepted as a
valid limit through `Number()` coercion.

The archive scan now validates each candidate's timestamp suffix against
OpenClaw's ISO `YYYY-MM-DDTHH-MM-SS[.sss]Z` format (mirroring the upstream
`ARCHIVE_TIMESTAMP_RE`), so trailing-garbage files such as
`<sid>.jsonl.reset.<ts>.bak` (rsync / manual backup leftovers) no longer
outrank the legitimate archive in lexicographic ordering.

Note: `resolveTranscriptFile` is shared by `getById` and `nativeui.sessions.get`
/ `coclaw.topics.getHistory`, so the `.deleted.*` fallback also applies to
those RPCs. This is a deliberate side-effect — the OpenClaw archive
`reset.*` / `deleted.*` pair represents the same "final transcript" state
(both produced by `archiveSessionTranscripts*` in `session-transcript-files.fs.ts`)
and the consumer impact for `get` is zero in current UI code (no UI caller
of `nativeui.sessions.get`; `coclaw.topics.getHistory` is already marked for
deprecation in favor of `getById`). The `get` RPC's own `limit` clamp
(`clamp(..., 1, 500, 100)`) is intentionally left untouched.

UI consumers (`__loadTopicMessages`, `loadNextHistorySession` in
`ui/src/stores/chat.store.js`) will now receive complete transcripts for
sessions exceeding 500 messages.
