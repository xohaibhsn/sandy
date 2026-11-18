-- 0009-shipping-courier.sql
-- SANDY-BATCH-12: shipping zones, couriers, per-product requires_shipping, and order shipping / courier / RTO columns.
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded ADD COLUMN / ADD KEY. utf8mb4 / InnoDB. NO data rows
-- (no seeded zones, rates or couriers). No backfill: legacy orders keep NULL shipping/courier/RTO values.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run after 0001-0008 (and tax SQL if building a fresh shop DB). Requires products and orders from 0002
-- and orders.customer_phone_norm from 0007 (used by the RTO index).
--
-- Feature flag: site_content.shipping_enabled stays "0" (or absent) until acceptance. Running this file
-- changes nothing visible to customers while the flag is off.

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('products', 'orders', 'shipping_zones', 'couriers');

SELECT TABLE_NAME, COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'products' AND COLUMN_NAME = 'requires_shipping')
    OR (TABLE_NAME = 'orders' AND COLUMN_NAME IN (
      'shipping_amount', 'shipping_zone', 'courier_id', 'tracking_number',
      'shipped_at', 'delivered_at', 'rto', 'rto_at'
    ))
  );

-- ========== shipping_zones ==========
CREATE TABLE IF NOT EXISTS shipping_zones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  cities TEXT NULL,
  provinces TEXT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  rate DECIMAL(10,2) NOT NULL DEFAULT 0,
  free_min DECIMAL(10,2) NULL,
  estimate_text VARCHAR(120) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== couriers ==========
CREATE TABLE IF NOT EXISTS couriers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  tracking_url_template VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== products.requires_shipping (default 1 = ships) ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'requires_shipping') = 0,
  'ALTER TABLE products ADD COLUMN requires_shipping TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== orders shipping / courier / RTO columns (all nullable; no backfill) ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipping_amount') = 0,
  'ALTER TABLE orders ADD COLUMN shipping_amount DECIMAL(10,2) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipping_zone') = 0,
  'ALTER TABLE orders ADD COLUMN shipping_zone VARCHAR(120) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'courier_id') = 0,
  'ALTER TABLE orders ADD COLUMN courier_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'tracking_number') = 0,
  'ALTER TABLE orders ADD COLUMN tracking_number VARCHAR(100) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipped_at') = 0,
  'ALTER TABLE orders ADD COLUMN shipped_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'delivered_at') = 0,
  'ALTER TABLE orders ADD COLUMN delivered_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'rto') = 0,
  'ALTER TABLE orders ADD COLUMN rto TINYINT(1) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'rto_at') = 0,
  'ALTER TABLE orders ADD COLUMN rto_at DATETIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== orders index for the RTO / COD-risk history lookup ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_rto_phone') = 0,
  'ALTER TABLE orders ADD KEY idx_orders_rto_phone (rto, customer_phone_norm)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('shipping_zones', 'couriers')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'products' AND COLUMN_NAME = 'requires_shipping')
    OR (TABLE_NAME = 'orders' AND COLUMN_NAME IN (
      'shipping_amount', 'shipping_zone', 'courier_id', 'tracking_number',
      'shipped_at', 'delivered_at', 'rto', 'rto_at'
    ))
  )
ORDER BY TABLE_NAME, COLUMN_NAME;

SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND INDEX_NAME = 'idx_orders_rto_phone'
ORDER BY SEQ_IN_INDEX;
