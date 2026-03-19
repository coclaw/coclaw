/*
  Warnings:

  - Made the column `userId` on table `botbindingcode` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `botbindingcode` MODIFY `userId` BIGINT UNSIGNED NOT NULL;

-- CreateTable
CREATE TABLE `ClawClaimCode` (
    `code` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `ClawClaimCode_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
