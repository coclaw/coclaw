---
"@coclaw/openclaw-coclaw": minor
---

Distinguish "transcript gone" from other empty results in `coclaw.sessions.getById`

`getById` used to collapse three very different outcomes into the same empty
array, so callers could not tell why a session had no content. It now signals
the cause through the response's `ok`/error channel and an optional sibling field:

- Transcript file missing (no bare / `.reset.` / `.deleted.` variant) → throws
  `code: 'NOT_FOUND'` → the handler responds `ok: false`.
- A non-empty transcript where not a single line parses → `code: 'PARSE_FAILED'`.
- Partial corruption (some lines parse, individual JSON lines are broken) stays
  fault-tolerant: the parsed messages are returned and the broken lines are
  reported in a parallel `badLines` array (`{ index, raw, error }`, present only
  when non-empty, raw kept untruncated) for diagnostics — the conversation is no
  longer lost over one corrupt tail line.
- Empty file, all-whitespace file, or a file with valid JSON but no displayable
  `message` rows remain benign empties (`{ messages: [] }`, no error).

Real disk I/O errors keep propagating as before. The "transcript present but no
displayable rows" benign empty is deliberately kept on the success path so it is
never mistaken for a truly-missing transcript.
