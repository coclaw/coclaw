---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): topic 标题生成内部 agentRpc 超时 60s → 5min

原 60s 在慢模型 / 复杂对话下普遍超时，导致 `coclaw.topics.generateTitle` 失败。调高到 300s 给 LLM 足够的推理时间。`acceptTimeoutMs` 保持 10s（accept 阶段一般秒级完成）。
