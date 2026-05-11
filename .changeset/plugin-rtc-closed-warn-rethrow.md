---
"@coclaw/openclaw-coclaw": patch
---

Surface `rtc:closed` close failures with a dedicated `closeByConnId failed on rtc:closed` warn before rethrowing, so the outer `rtc.signaling-error` from `realtime-bridge` is paired with a localized signal that pinpoints the close path. The rethrow keeps the existing outer-catch contract intact — gateway stability is unchanged. Also pins the pre-existing `closeAll` snapshot semantics: sessions established after `closeAll` enters `await Promise.all` are not included in that batch, and the new session keeps its `onconnectionstatechange` handler so the 12h `__failedTimer` fallback can reclaim resources naturally.
