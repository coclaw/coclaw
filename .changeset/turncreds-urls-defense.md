---
'@coclaw/openclaw-coclaw': patch
---

Fix: rtc:offer 处理对 `turnCreds.urls` 加防御性校验。原实现 `for of urls` 在 `urls` 缺失时抛 TypeError、在 `urls` 为单 string 时被字符级迭代成无效 iceServers — 都会让 offer 处理中断或产生畸形 PC 配置。修复后 urls 必须是 string 数组，否则跳过并 warn，让 PC 走 host-only 候选继续协商。
