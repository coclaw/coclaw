---
'@coclaw/openclaw-coclaw': patch
---

Fix: dc-chunking 接收端 string 帧上限改用 `Buffer.byteLength(data, 'utf8')` 而非 `data.length` 比较。原实现按 UTF-16 code unit 数判定，CJK 等多字节字符（UTF-8 占 3 字节）实际 byte 数被低估近 3 倍，可能让 ~150MB 字节的字符串通过 50MB 上限。
