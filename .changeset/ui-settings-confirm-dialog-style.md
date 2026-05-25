---
'@coclaw/ui': patch
---

style(ui): align settings password and clear-chats dialogs to shared confirm style

Apply the shared `promptModalUi` look to the change-password and
clear-chats confirm dialogs in `UserSettingsPanel` so they match the
prompt/confirm style used elsewhere: narrower width, no dividers, and a
right-aligned footer with a neutral cancel button. The clear-chats
danger description moves from the header into the body, matching the
delete-dir confirm pattern.
