---
'@coclaw/ui': patch
---

fix(ui): i18n the ProgressRing aria-label at the three call sites

`ProgressRing` defaults its `aria-label` prop to the hardcoded English
string "Progress", and none of its three call sites — the upload overlay
in `ChatInput`, the running task in `FileUploadItem`, and the download
progress in `FileListItem` — overrode it. Screen-reader users in any
non-English locale heard the same generic English label regardless of
whether the ring meant "uploading" or "downloading".

Adds two i18n keys (`files.uploading`, `files.downloading`) to all 12
locales and wires `:aria-label="$t('files.uploading' | 'files.downloading')"`
onto the three call sites. The component default ("Progress") is kept
as a generic fallback for any future scenario-agnostic usage.
