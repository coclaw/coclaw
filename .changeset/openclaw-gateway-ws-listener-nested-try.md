---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/realtime-bridge): nest try/catch around logger.warn in gateway ws message listener's IIFE catch

The gateway ws `message` listener wraps its body in an IIFE with
`.catch(err => this.logger.warn?.(…))` to keep async throws from
escalating into unhandled rejections that would crash the gateway.
The catch handler itself, however, synchronously calls
`logger.warn?.()` — if the injected logger's `warn` implementation
throws (e.g. a misbehaving pino transport, or a logger stub that
asserts on string format and rejects), the catch handler throws
synchronously and the IIFE chain settles to a new rejected promise
nobody awaits. That is exactly the unhandled rejection the outer
catch was meant to prevent.

Wrap the `logger.warn` call in a nested `try/catch` so a throwing
logger is swallowed at this last-mile boundary. Pure defensive
nesting — no behaviour change on the happy path.

Adds a red test that injects a throwing `warn`, drives a malformed
event through the listener, and asserts no `unhandledRejection`
escapes. Reverse-verified the test against the unpatched source:
without the nested try/catch it fails with
`unhandledRejection: logger.warn broken`, confirming it actually
guards the regression.
