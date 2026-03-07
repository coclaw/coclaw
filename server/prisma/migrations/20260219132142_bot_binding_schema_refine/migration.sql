/*
  Warnings:

  - You are about to drop the `device` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `pairingcode` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `device` DROP FOREIGN KEY `Device_userId_fkey`;

-- DropTable
DROP TABLE `device`;

-- DropTable
DROP TABLE `pairingcode`;

-- CreateTable
CREATE TABLE `Bot` (
    `id` BIGINT UNSIGNED NOT NULL,
    `userId` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `tokenHash` VARCHAR(255) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Bot_userId_idx`(`userId`),
    INDEX `Bot_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `Bot_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BotBindingCode` (
    `code` VARCHAR(16) NOT NULL,
    `userId` BIGINT UNSIGNED NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `BotBindingCode_userId_idx`(`userId`),
    INDEX `BotBindingCode_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Bot` ADD CONSTRAINT `Bot_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
