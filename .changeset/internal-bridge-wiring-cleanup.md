---
'@coclaw/openclaw-coclaw': patch
---

Internal refactor of bridge ↔ chat-history wiring (no runtime behavior
change):

- `restartBridge` in the plugin entry now passes `handleSessionCreated`
  directly as `onSessionCreated`; the previous inline `({ sessionKey,
  sessionId }) => handleSessionCreated({...})` adapter is removed. The
  semantics are unchanged because `handleSessionCreated` already falls
  back when `agentId` and `archivedSessionId` are missing (which is the
  case for the `sessions.changed reason=create` event payload). The
  adapter's documentation has been folded into the
  `handleSessionCreated` jsdoc so the bridge-vs-hook input contract is
  co-located with the function it describes.
- A test-only `__getSingletonForTest()` export is added to
  `realtime-bridge.js`. It lets the bridge test suite pin the wiring
  contract `restartRealtimeBridge({ onSessionCreated }) ⇒ singleton.__onSessionCreated === cb`,
  including the negative case where a subsequent restart without the
  callback recreates a singleton with `__onSessionCreated = null`.
