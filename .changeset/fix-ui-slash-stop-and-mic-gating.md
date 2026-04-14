---
"@coclaw/ui": patch
---

fix(ui): disable STOP for all slash commands & gate desktop mic button

- 斜杠命令（`/new`、`/reset`、`/help` 等）无服务端取消通道，点击 STOP 仅清本地乐观消息而不会中断服务端命令。原先只 disable `/compact` 的 STOP，其它斜杠命令的 STOP 可点击但无效。现在统一：任何斜杠命令进行中 STOP 按钮禁用，避免"按了没用"的错觉。
- 桌面麦克风按钮此前未跟随 `disabled` prop —— claw 离线 / 预 accepted 期间仍可点击开始录音。现在按钮绑定 `:disabled="disabled"`，`onStartDesktopRecording` 头部早退，与 textarea / `+` 按钮 / 触屏"按住说话"对齐。
