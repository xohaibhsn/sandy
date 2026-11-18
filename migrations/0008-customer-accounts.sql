-- 0008-customer-accounts.sql
-- Customer addresses, wishlist, and optional orders.customer_id for account linking.
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded ADD COLUMN / ADD KEY. utf8mb4 / InnoDB. No data rows.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run after 0001–0007 (and tax SQL if building a fresh shop DB). Requires customers table from 0006
-- and orders from 0002 (customer_id is nullable; no FK; no backfill).

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'customers',
    'customer_sessions',
    'customer_addresses',
    'customer_wishlist',
    'orders'
  );

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME = 'customer_id';

-- ========== customer_addresses ==========
CREATE TABLE IF NOT EXISTS customer_addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  label VARCHAR(60) NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  line1 VARCHAR(500) NOT NULL,
  line2 VARCHAR(500) NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(100) NULL,
  postcode VARCHAR(100) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_customer_addresses_customer_id (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== customer_wishlist ==========
CREATE TABLE IF NOT EXISTS customer_wishlist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  product_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wishlist (customer_id, product_id),
  KEY idx_customer_wishlist_customer_id (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== orders.customer_id (nullable; no backfill) ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'customer_id') = 0,
  'ALTER TABLE orders ADD COLUMN customer_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_customer_id') = 0,
  'ALTER TABLE orders ADD KEY idx_orders_customer_id (customer_id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'customer_addresses',
    'customer_wishlist'
  )
ORDER BY TABLE_NAME;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND COLUMN_NAME = 'customer_id';

SELECT INDEX_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND INDEX_NAME = 'idx_orders_customer_id';
