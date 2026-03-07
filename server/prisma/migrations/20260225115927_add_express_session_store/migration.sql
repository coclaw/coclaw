-- CreateTable
CREATE TABLE `ExpressSession` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `sid` VARCHAR(128) NOT NULL,
    `data` MEDIUMTEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExpressSession_sid_key`(`sid`),
    INDEX `ExpressSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
