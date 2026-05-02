---
'@coclaw/openclaw-coclaw': patch
---

Fix: `loadOrCreateDeviceIdentity` 改用新增的 `atomicWriteFileSync` 写入设备身份文件，替换原来的裸 `fs.writeFileSync`。原先在写入过程中崩溃可能截断 `device-identity.json`，下次启动时解析失败重新生成新 deviceId，使设备绑定关系全部失效。同步 atomic 工具沿用 tmp + rename + finally 清理模式。
