/*
  Warnings:

  - You are about to drop the column `status` on the `bot` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `bot` DROP COLUMN `status`,
    MODIFY `name` VARCHAR(128) NULL;
