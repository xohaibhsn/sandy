-- 0012-phpmyadmin-full.sql
-- SANDY-BATCH-53: phpMyAdmin-safe copy of migrations/0012-tax-schema.sql
-- Literal schema u992747032_sandy. Qualified names. Pre/post checks.
-- Already applied on production on 2026-11-17 via 01-tax-config-migrate.sql — running it there is a no-op; for fresh databases only.
-- Owner-only. The application NEVER executes this file.
-- Seeds tax CLASS rows only (no rate rows).

USE `u992747032_sandy`;

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'u992747032_sandy'
  AND TABLE_NAME IN ('tax_classes','tax_rates','tax_rules','order_tax_snapshots','products','orders');

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'u992747032_sandy'
  AND TABLE_NAME = 'products'
  AND COLUMN_NAME = 'tax_class_id';

-- ========== TABLES ==========
CREATE TABLE IF NOT EXISTS `u992747032_sandy`.`tax_classes` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  applies_to ENUM('domestic','international','both') NOT NULL DEFAULT 'both',
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tax_classes_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `u992747032_sandy`.`tax_rates` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tax_class_id INT NOT NULL,
  rate_percent DECIMAL(7,4) NOT NULL,
  effective_from DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(255) NULL,
  KEY idx_tax_rates_class_from (tax_class_id, effective_from),
  CONSTRAINT fk_tax_rates_class FOREIGN KEY (tax_class_id) REFERENCES `u992747032_sandy`.`tax_classes`(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `u992747032_sandy`.`tax_rules` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tax_base ENUM('after_discount','before_discount') NOT NULL DEFAULT 'after_discount',
  shipping_taxable TINYINT(1) NOT NULL DEFAULT 0,
  rounding ENUM('per_line_whole_rupee') NOT NULL DEFAULT 'per_line_whole_rupee',
  tax_label VARCHAR(64) NOT NULL DEFAULT 'GST',
  prices_include_tax TINYINT(1) NOT NULL DEFAULT 0,
  effective_from DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tax_rules_from (effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `u992747032_sandy`.`order_tax_snapshots` (
  order_id VARCHAR(64) NOT NULL,
  tax_label VARCHAR(64) NOT NULL,
  vat_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  snapshot_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- products.tax_class_id (guarded)
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'u992747032_sandy'
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'tax_class_id'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `u992747032_sandy`.`products` ADD COLUMN tax_class_id INT NULL',
  'SELECT ''products.tax_class_id already exists'' AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ========== SEED (tax classes only; no rate rows) ==========
INSERT INTO `u992747032_sandy`.`tax_classes` (name, slug, applies_to, active, sort_order)
SELECT * FROM (
  SELECT 'Physical goods' AS name, 'physical-goods' AS slug, 'both' AS applies_to, 1 AS active, 10 AS sort_order
  UNION ALL SELECT 'Digital products', 'digital-products', 'both', 1, 20
  UNION ALL SELECT 'Services', 'services', 'both', 1, 30
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM `u992747032_sandy`.`tax_classes` LIMIT 1);

-- ========== POST-CHECK ==========
SELECT id, name, slug, applies_to, active FROM `u992747032_sandy`.`tax_classes` ORDER BY sort_order;
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'products' AND COLUMN_NAME = 'tax_class_id';
SELECT COUNT(*) AS order_tax_snapshots_exists
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'order_tax_snapshots';
