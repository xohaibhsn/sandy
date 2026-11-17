-- 0005-orders-cancel-reason.sql
-- Adds orders.cancel_reason for admin cancel-reason capture on cancelled orders.
-- Idempotent: guarded via INFORMATION_SCHEMA + PREPARE (same style as 0002/0003).
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Production already has this column (verified 2026-11-18). This file exists so a fresh
-- database built from migrations 0001-0005 matches live schema. Running it on production
-- is a no-op when the column is already present.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run after 0002 (orders table must exist).

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME IN ('status', 'cancel_reason');

-- ========== orders.cancel_reason ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'cancel_reason') = 0,
  'ALTER TABLE orders ADD COLUMN cancel_reason VARCHAR(500) NULL DEFAULT NULL AFTER status',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME = 'cancel_reason';
