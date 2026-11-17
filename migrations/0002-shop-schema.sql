-- 0002-shop-schema.sql
-- Reference schema for the shop tables: products, orders, order_items, order_checkout_attempts.
-- Idempotent: CREATE TABLE IF NOT EXISTS; every ADD COLUMN / ADD UNIQUE KEY is guarded via
-- INFORMATION_SCHEMA + PREPARE, so running it twice (or on an older database) is harmless.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Definitions match, statement for statement, what lib/ensureShopTables.ts and
-- lib/ensureOrderIdempotency.ts created at runtime before they were removed (SANDY-BATCH-05).
-- Deliberately NOT included (they were data changes, not schema):
--   * seeding two sample products when the table was empty
--   * slug backfill / de-duplication
--   * UPDATE products SET active = 1 WHERE active IS NULL
-- The public catalog treats active IS NULL as active, so none of those are needed.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run 0001 first only if you also need contact_messages; this file does not depend on it.

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('products','orders','order_items','order_checkout_attempts');

-- ========== products ==========
CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255),
  description TEXT,
  short_description TEXT,
  full_description TEXT,
  price DECIMAL(10,2) DEFAULT 0,
  category VARCHAR(100),
  badge VARCHAR(100),
  image VARCHAR(500),
  stock VARCHAR(100) DEFAULT 'In Stock',
  track_inventory TINYINT(1) NOT NULL DEFAULT 1,
  stock_quantity INT NULL,
  features TEXT,
  seo_title VARCHAR(60),
  meta_description VARCHAR(160),
  focus_keyword VARCHAR(100),
  og_image VARCHAR(500),
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Columns that older databases may lack (same list and definitions as the removed runtime code).
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'slug') = 0,
  'ALTER TABLE products ADD COLUMN slug VARCHAR(255)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'short_description') = 0,
  'ALTER TABLE products ADD COLUMN short_description TEXT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'full_description') = 0,
  'ALTER TABLE products ADD COLUMN full_description TEXT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'seo_title') = 0,
  'ALTER TABLE products ADD COLUMN seo_title VARCHAR(60)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'meta_description') = 0,
  'ALTER TABLE products ADD COLUMN meta_description VARCHAR(160)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'focus_keyword') = 0,
  'ALTER TABLE products ADD COLUMN focus_keyword VARCHAR(100)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'features') = 0,
  'ALTER TABLE products ADD COLUMN features TEXT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'og_image') = 0,
  'ALTER TABLE products ADD COLUMN og_image VARCHAR(500)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'active') = 0,
  'ALTER TABLE products ADD COLUMN active TINYINT(1) DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'created_at') = 0,
  'ALTER TABLE products ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'stock') = 0,
  'ALTER TABLE products ADD COLUMN stock VARCHAR(100) DEFAULT ''In Stock''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'track_inventory') = 0,
  'ALTER TABLE products ADD COLUMN track_inventory TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'stock_quantity') = 0,
  'ALTER TABLE products ADD COLUMN stock_quantity INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'badge') = 0,
  'ALTER TABLE products ADD COLUMN badge VARCHAR(100)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'image') = 0,
  'ALTER TABLE products ADD COLUMN image VARCHAR(500)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'category') = 0,
  'ALTER TABLE products ADD COLUMN category VARCHAR(100)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'description') = 0,
  'ALTER TABLE products ADD COLUMN description TEXT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'price') = 0,
  'ALTER TABLE products ADD COLUMN price DECIMAL(10,2) DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'name') = 0,
  'ALTER TABLE products ADD COLUMN name VARCHAR(255) NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== orders ==========
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(50) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  customer_phone VARCHAR(50),
  delivery_address TEXT,
  city VARCHAR(100),
  postcode VARCHAR(100),
  notes TEXT,
  payment_method VARCHAR(50) DEFAULT 'cod',
  receipt_path VARCHAR(500),
  payment_reference VARCHAR(255),
  total DECIMAL(10,2) DEFAULT 0,
  coupon_code VARCHAR(50),
  discount_amount DECIMAL(10,2) DEFAULT 0,
  vat_amount DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'coupon_code') = 0,
  'ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(50)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'discount_amount') = 0,
  'ALTER TABLE orders ADD COLUMN discount_amount DECIMAL(10,2) DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'vat_amount') = 0,
  'ALTER TABLE orders ADD COLUMN vat_amount DECIMAL(10,2) DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'payment_reference') = 0,
  'ALTER TABLE orders ADD COLUMN payment_reference VARCHAR(255)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'created_at') = 0,
  'ALTER TABLE orders ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'status') = 0,
  'ALTER TABLE orders ADD COLUMN status VARCHAR(50) DEFAULT ''pending''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- payment_method: widen/default (runtime code ran MODIFY COLUMN ... VARCHAR(50) DEFAULT 'cod'). Guarded: only runs when the definition differs.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'payment_method'
     AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 50
     AND COLUMN_DEFAULT IN ('cod', '''cod''')) = 0,
  'ALTER TABLE orders MODIFY COLUMN payment_method VARCHAR(50) DEFAULT ''cod''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== order_items ==========
CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL,
  product_id INT,
  product_name VARCHAR(255),
  price DECIMAL(10,2),
  quantity INT DEFAULT 1
);

-- ========== order_checkout_attempts (checkout idempotency) ==========
CREATE TABLE IF NOT EXISTS order_checkout_attempts (
  idempotency_key VARCHAR(64) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  order_id VARCHAR(50) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (idempotency_key),
  UNIQUE KEY uq_order_checkout_attempts_order_id (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== products.unique_slug (last on purpose) ==========
-- Duplicate non-empty slugs would make the ADD UNIQUE KEY below fail (everything above is already applied).
-- This must return no rows; fix any duplicates by hand first, then re-run the file.
SELECT slug, COUNT(*) AS duplicates
FROM products
WHERE slug IS NOT NULL AND slug <> ''
GROUP BY slug
HAVING COUNT(*) > 1;
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'unique_slug') = 0,
  'ALTER TABLE products ADD UNIQUE KEY unique_slug (slug)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, COUNT(*) AS column_count
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('products','orders','order_items','order_checkout_attempts')
GROUP BY TABLE_NAME;
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('products','orders','order_items','order_checkout_attempts')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
