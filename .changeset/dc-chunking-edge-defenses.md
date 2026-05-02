---
'@coclaw/openclaw-coclaw': patch
---

Fix: dc-chunking 协议加 3 项边界防护：(1) 接收端拒绝未知 flag 字节（非 BEGIN/MIDDLE/END），避免畸形帧污染同 msgId 的 pending entry；(2) 接收端对 string 帧长度做 50MB 上限检查（与 sender 端 MAX_REASSEMBLY_BYTES 对齐，防 peer 绕过）；(3) buildChunks 在数学上会产生 > MAX_CHUNKS_PER_MSG (10000) 的分片数量时早抛错（极小 maxMessageSize 配置下接收端会拒绝末尾 chunk，整条消息无法重组）。
