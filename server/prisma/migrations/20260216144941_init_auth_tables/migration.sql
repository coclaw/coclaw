-- CreateTable
CREATE TABLE `User` (
    `id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(128) NULL,
    `avatar` TEXT NULL,
    `level` TINYINT NOT NULL DEFAULT 0,
    `locked` BOOLEAN NOT NULL DEFAULT false,
    `lockReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastLoginAt` DATETIME(3) NULL,

    INDEX `User_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LocalAuth` (
    `userId` BIGINT UNSIGNED NOT NULL,
    `loginName` VARCHAR(63) NULL,
    `email` VARCHAR(128) NULL,
    `phone` VARCHAR(32) NULL,
    `workId` VARCHAR(63) NULL,
    `passwordHash` VARCHAR(255) NULL,
    `passwordUpdatedAt` DATETIME(3) NULL,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `locked` BOOLEAN NOT NULL DEFAULT false,
    `lockReason` TEXT NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LocalAuth_loginName_key`(`loginName`),
    UNIQUE INDEX `LocalAuth_email_key`(`email`),
    UNIQUE INDEX `LocalAuth_phone_key`(`phone`),
    UNIQUE INDEX `LocalAuth_workId_key`(`workId`),
    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExternalAuth` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `userId` BIGINT UNSIGNED NOT NULL,
    `oauthType` VARCHAR(16) NOT NULL,
    `oauthName` VARCHAR(128) NOT NULL,
    `oauthId` VARCHAR(128) NOT NULL,
    `oauthAppId` VARCHAR(63) NULL,
    `oauthAvatar` TEXT NULL,
    `wxAppId` VARCHAR(63) NULL,
    `locked` BOOLEAN NOT NULL DEFAULT false,
    `lockReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastLoginAt` DATETIME(3) NULL,

    INDEX `ExternalAuth_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `ExternalAuth_oauthType_oauthId_key`(`oauthType`, `oauthId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LocalAuth` ADD CONSTRAINT `LocalAuth_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExternalAuth` ADD CONSTRAINT `ExternalAuth_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
