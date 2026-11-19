-- 0010-delivery-ops.sql
-- SANDY-BATCH-17: delivery operations. Creates shipping_areas, riders and pickup_points (no seed rows), adds
-- shipping_zones.delivery_method / same_day_cutoff and nullable orders.fulfilment / shipping_area / rider_id /
-- pickup_point_id / pickup_point_name.
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded ADD COLUMN / ADD KEY (INFORMATION_SCHEMA + PREPARE).
-- utf8mb4 / InnoDB. NO data rows (no areas, riders, pickup points). No backfill: legacy orders keep NULL values
-- and existing zones become delivery_method = 'courier' (the column default), i.e. unchanged behaviour.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run after 0009 (needs shipping_zones from 0009 and orders from 0002).
--
-- Feature flags: site_content.shipping_areas_enabled, shipping_restrict_to_zones and pickup_enabled stay "0"
-- (or absent) until acceptance. Running this file changes nothing visible to customers while they are off.

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
-- Expect orders, shipping_zones (0009) present; shipping_areas / riders / pickup_points absent on first run.
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('orders', 'shipping_zones', 'couriers', 'shipping_areas', 'riders', 'pickup_points');

SELECT TABLE_NAME, COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'shipping_zones' AND COLUMN_NAME IN ('delivery_method', 'same_day_cutoff'))
    OR (TABLE_NAME = 'orders' AND COLUMN_NAME IN ('fulfilment', 'shipping_area', 'rider_id', 'pickup_point_id', 'pickup_point_name'))
  );

-- ========== shipping_areas ==========
CREATE TABLE IF NOT EXISTS shipping_areas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  city VARCHAR(100) NOT NULL,
  name VARCHAR(120) NOT NULL,
  parent_id INT NULL,
  zone_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== riders ==========
CREATE TABLE IF NOT EXISTS riders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_riders_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== pickup_points ==========
CREATE TABLE IF NOT EXISTS pickup_points (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(100) NOT NULL,
  address VARCHAR(300) NOT NULL,
  hours_text VARCHAR(120) NULL,
  map_url VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== shipping_areas index ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shipping_areas' AND INDEX_NAME = 'idx_shipping_areas_city_parent') = 0,
  'ALTER TABLE shipping_areas ADD KEY idx_shipping_areas_city_parent (city, parent_id, active)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== shipping_zones: delivery method + same-day cutoff (PKT wall-clock TIME, owner data) ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shipping_zones' AND COLUMN_NAME = 'delivery_method') = 0,
  'ALTER TABLE shipping_zones ADD COLUMN delivery_method VARCHAR(20) NOT NULL DEFAULT ''courier''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shipping_zones' AND COLUMN_NAME = 'same_day_cutoff') = 0,
  'ALTER TABLE shipping_zones ADD COLUMN same_day_cutoff TIME NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== orders: fulfilment / area snapshot / rider / pickup point (all nullable; no backfill) ==========
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'fulfilment') = 0,
  'ALTER TABLE orders ADD COLUMN fulfilment VARCHAR(20) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipping_area') = 0,
  'ALTER TABLE orders ADD COLUMN shipping_area VARCHAR(160) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'rider_id') = 0,
  'ALTER TABLE orders ADD COLUMN rider_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'pickup_point_id') = 0,
  'ALTER TABLE orders ADD COLUMN pickup_point_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'pickup_point_name') = 0,
  'ALTER TABLE orders ADD COLUMN pickup_point_name VARCHAR(120) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ========== POST-CHECK ==========
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('shipping_areas', 'riders', 'pickup_points')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'shipping_zones' AND COLUMN_NAME IN ('delivery_method', 'same_day_cutoff'))
    OR (TABLE_NAME = 'orders' AND COLUMN_NAME IN ('fulfilment', 'shipping_area', 'rider_id', 'pickup_point_id', 'pickup_point_name'))
  )
ORDER BY TABLE_NAME, COLUMN_NAME;

SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('shipping_areas', 'riders')
  AND INDEX_NAME IN ('idx_shipping_areas_city_parent', 'uq_riders_phone')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Expect 0 rows each (no data is seeded):
SELECT (SELECT COUNT(*) FROM shipping_areas) AS shipping_areas_rows,
       (SELECT COUNT(*) FROM riders) AS riders_rows,
       (SELECT COUNT(*) FROM pickup_points) AS pickup_points_rows;
