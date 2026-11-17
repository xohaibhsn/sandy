-- 0007-orders-protection-columns.sql
-- Adds nullable COD-protection columns on orders. No backfill.
-- Legacy rows keep NULL norms and do not count for "new customer" or blacklist history by norm.
-- Idempotent: every ADD COLUMN / ADD KEY is guarded via INFORMATION_SCHEMA + PREPARE.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Before running: confirm the database name and take a backup. Run after 0002 (orders must exist).
-- Prefer running 0006 before or after — no FK dependency either way.

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME IN (
    'customer_phone_norm',
    'customer_email_norm',
    'risk_score',
    'risk_reasons',
    'otp_verified',
    'confirmation_method',
    'confirmation_note',
    'confirmed_by',
    'confirmed_at',
    'advance_amount',
    'advance_reference',
    'advance_receipt_path'
  );

-- ========== columns ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'customer_phone_norm') = 0,
  'ALTER TABLE orders ADD COLUMN customer_phone_norm VARCHAR(20) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'customer_email_norm') = 0,
  'ALTER TABLE orders ADD COLUMN customer_email_norm VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'risk_score') = 0,
  'ALTER TABLE orders ADD COLUMN risk_score SMALLINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'risk_reasons') = 0,
  'ALTER TABLE orders ADD COLUMN risk_reasons VARCHAR(500) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'otp_verified') = 0,
  'ALTER TABLE orders ADD COLUMN otp_verified TINYINT(1) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'confirmation_method') = 0,
  'ALTER TABLE orders ADD COLUMN confirmation_method ENUM(''call'',''whatsapp'') NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'confirmation_note') = 0,
  'ALTER TABLE orders ADD COLUMN confirmation_note VARCHAR(500) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'confirmed_by') = 0,
  'ALTER TABLE orders ADD COLUMN confirmed_by VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'confirmed_at') = 0,
  'ALTER TABLE orders ADD COLUMN confirmed_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'advance_amount') = 0,
  'ALTER TABLE orders ADD COLUMN advance_amount DECIMAL(10,2) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'advance_reference') = 0,
  'ALTER TABLE orders ADD COLUMN advance_reference VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'advance_receipt_path') = 0,
  'ALTER TABLE orders ADD COLUMN advance_receipt_path VARCHAR(500) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== indexes ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_customer_phone_norm') = 0,
  'ALTER TABLE orders ADD KEY idx_orders_customer_phone_norm (customer_phone_norm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_customer_email_norm') = 0,
  'ALTER TABLE orders ADD KEY idx_orders_customer_email_norm (customer_email_norm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME IN (
    'customer_phone_norm',
    'customer_email_norm',
    'risk_score',
    'risk_reasons',
    'otp_verified',
    'confirmation_method',
    'confirmation_note',
    'confirmed_by',
    'confirmed_at',
    'advance_amount',
    'advance_reference',
    'advance_receipt_path'
  )
ORDER BY COLUMN_NAME;
