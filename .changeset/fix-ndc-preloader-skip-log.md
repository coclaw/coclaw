---
"@coclaw/openclaw-coclaw": patch
---

fix(webrtc): log the ndc preloader's post-removal fallback as `ndc.skip reason=ndc-not-installed` when `node-datachannel` resolves to MODULE_NOT_FOUND, instead of the misleading `ndc.fallback reason=unexpected`; genuine unexpected errors still report `unexpected`.
