-- AddColumns: Claw 新增 plugin 上报的三字段
-- 纯 ADD COLUMN nullable，MySQL 在线 DDL 即时元数据变更，零停机
-- 向后兼容：老 plugin 不上报时新字段为 null

ALTER TABLE `Claw`
	ADD COLUMN `hostName` VARCHAR(128) NULL,
	ADD COLUMN `pluginVersion` VARCHAR(32) NULL,
	ADD COLUMN `agentModels` JSON NULL;
