-- RenameTables: bot -> Claw, botbindingcode -> ClawBindingCode
-- 纯 DDL，无数据迁移
-- 单条 RENAME TABLE 多表语法确保原子性（全部成功或全部回滚）

RENAME TABLE `bot` TO `Claw`, `botbindingcode` TO `ClawBindingCode`;

-- 同步重命名索引（RENAME TABLE 不会自动更新索引名）
ALTER TABLE `Claw` RENAME INDEX `Bot_tokenHash_key` TO `Claw_tokenHash_key`;
ALTER TABLE `Claw` RENAME INDEX `Bot_createdAt_idx` TO `Claw_createdAt_idx`;
ALTER TABLE `ClawBindingCode` RENAME INDEX `BotBindingCode_userId_idx` TO `ClawBindingCode_userId_idx`;
ALTER TABLE `ClawBindingCode` RENAME INDEX `BotBindingCode_expiresAt_idx` TO `ClawBindingCode_expiresAt_idx`;

-- 重命名外键约束（需 drop + add）
ALTER TABLE `Claw` DROP FOREIGN KEY `Bot_userId_fkey`;
ALTER TABLE `Claw` ADD CONSTRAINT `Claw_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 保留 Bot_userId_idx 并重命名：Prisma 为关系字段自动生成的索引
ALTER TABLE `Claw` RENAME INDEX `Bot_userId_idx` TO `Claw_userId_idx`;
