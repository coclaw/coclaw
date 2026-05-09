-- CreateTable
CREATE TABLE `WebAgent` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `userId` BIGINT UNSIGNED NULL,
    `slug` VARCHAR(63) NULL,
    `name` VARCHAR(128) NOT NULL,
    `url` VARCHAR(255) NOT NULL,
    `sort` INTEGER UNSIGNED NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WebAgent_slug_key`(`slug`),
    INDEX `WebAgent_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebAgentClick` (
    `userId` BIGINT UNSIGNED NOT NULL,
    `webAgentId` INTEGER UNSIGNED NOT NULL,
    `clickCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `lastClickedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WebAgentClick_userId_lastClickedAt_idx`(`userId`, `lastClickedAt` DESC),
    PRIMARY KEY (`userId`, `webAgentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebAgent` ADD CONSTRAINT `WebAgent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebAgentClick` ADD CONSTRAINT `WebAgentClick_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebAgentClick` ADD CONSTRAINT `WebAgentClick_webAgentId_fkey` FOREIGN KEY (`webAgentId`) REFERENCES `WebAgent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
