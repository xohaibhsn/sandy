-- 0003-admin-schema.sql
-- Admin / CMS schema: categories, coupons, admin_staff, admin_sessions, faqs, redirects,
-- site_content (+ section_order / is_visible / json content_type) and blog_posts (+ late columns).
-- Idempotent: CREATE TABLE IF NOT EXISTS; every ADD COLUMN / MODIFY COLUMN is guarded via
-- INFORMATION_SCHEMA + PREPARE, so running it twice (or on an older database) is harmless.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Definitions match, statement for statement, what the API handlers created at runtime before it
-- was removed (SANDY-BATCH-05 P1c): lib/ensureCategories.ts, lib/adminAuth.ts (admin_sessions),
-- lib/redirects.ts, pages/api/{admin-login,admin-staff,coupons,faqs,sections,site-content,blog}.ts.
--
-- This file contains NO data changes: no INSERT, UPDATE, DELETE or REPLACE. Default content rows live
-- in 0004-default-content-seed.sql (INSERT IGNORE / insert-if-empty only).
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Needs no other migration; 0004 must run AFTER this file.

SET NAMES utf8mb4;

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('categories','coupons','admin_staff','admin_sessions','faqs','redirects','site_content','blog_posts');

-- ========== categories ==========
CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  description TEXT NULL,
  image VARCHAR(500) NULL,
  parent_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_category_name (name),
  UNIQUE KEY unique_category_slug (slug),
  KEY idx_categories_active_sort (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== coupons ==========
CREATE TABLE IF NOT EXISTS coupons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  type ENUM('percentage','fixed') NOT NULL,
  value DECIMAL(10,2) NOT NULL,
  minimum_order DECIMAL(10,2) DEFAULT 0,
  usage_limit INT DEFAULT NULL,
  used_count INT DEFAULT 0,
  expires_at DATE DEFAULT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== admin_staff ==========
CREATE TABLE IF NOT EXISTS admin_staff (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','manager','writer') DEFAULT 'writer',
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== admin_sessions ==========
-- Admin login cannot work without this table (the app fails closed with 503 when it is missing).
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  staff_id INT NULL,
  is_master TINYINT(1) NOT NULL DEFAULT 0,
  role VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_sessions_token_hash (token_hash),
  KEY idx_admin_sessions_expires_at (expires_at)
);

-- ========== faqs ==========
CREATE TABLE IF NOT EXISTS faqs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category VARCHAR(100) DEFAULT 'General',
  sort_order INT DEFAULT 0,
  is_visible TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== redirects ==========
-- Public redirect lookup skips when this table is missing; the admin redirects API answers 503.
CREATE TABLE IF NOT EXISTS redirects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_path VARCHAR(500) NOT NULL,
  destination VARCHAR(2000) NOT NULL,
  status_code SMALLINT NOT NULL DEFAULT 301,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_redirects_source_path (source_path),
  KEY idx_redirect_active_source (is_active, source_path)
);

-- ========== site_content ==========
-- Used by pages/api/site-content.ts and pages/api/sections.ts. The CREATE is the original site-content
-- definition; sections then added section_order / is_visible and the 'json' ENUM value with ALTERs.
-- Doing the same here (guarded) gives the identical final table on a fresh or an older database.
CREATE TABLE IF NOT EXISTS site_content (
  id INT AUTO_INCREMENT PRIMARY KEY,
  content_key VARCHAR(100) UNIQUE NOT NULL,
  content_value TEXT,
  content_type ENUM('text','textarea','image','url') DEFAULT 'text',
  page_name VARCHAR(50),
  label VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add the section columns and extend the content_type ENUM with 'json' (each step only if still needed).

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'site_content' AND COLUMN_NAME = 'section_order') = 0,
  'ALTER TABLE site_content ADD COLUMN section_order INT DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'site_content' AND COLUMN_NAME = 'is_visible') = 0,
  'ALTER TABLE site_content ADD COLUMN is_visible TINYINT(1) DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- content_type: only widens the ENUM (adds 'json') when the current definition differs. Existing values are kept.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'site_content' AND COLUMN_NAME = 'content_type'
     AND COLUMN_TYPE = 'enum(''text'',''textarea'',''image'',''url'',''json'')'
     AND COLUMN_DEFAULT IN ('text', '''text''')) = 0,
  'ALTER TABLE site_content MODIFY COLUMN content_type ENUM(''text'',''textarea'',''image'',''url'',''json'') DEFAULT ''text''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== blog_posts ==========
CREATE TABLE IF NOT EXISTS blog_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500),
  excerpt TEXT,
  content LONGTEXT,
  category VARCHAR(100) DEFAULT 'Guides',
  emoji VARCHAR(10) DEFAULT '📝',
  badge VARCHAR(50) DEFAULT 'guide',
  badgeText VARCHAR(50) DEFAULT 'Guide',
  featured_image VARCHAR(1000),
  meta_title VARCHAR(500),
  meta_description VARCHAR(500),
  focus_keyword VARCHAR(255),
  status VARCHAR(20) DEFAULT 'published',
  featured TINYINT(1) DEFAULT 0,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Columns that older databases may lack (same list, order and definitions as the removed runtime code).
-- canonical_url and faqs are not in the CREATE above: they were only ever added by ALTER, so a fresh
-- database gets them at the end of the table, exactly as before.

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'badgeText') = 0,
  'ALTER TABLE blog_posts ADD COLUMN badgeText VARCHAR(50) DEFAULT ''Guide''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'slug') = 0,
  'ALTER TABLE blog_posts ADD COLUMN slug VARCHAR(500) AFTER title',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'content') = 0,
  'ALTER TABLE blog_posts ADD COLUMN content LONGTEXT AFTER excerpt',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'featured_image') = 0,
  'ALTER TABLE blog_posts ADD COLUMN featured_image VARCHAR(1000) AFTER badgeText',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'meta_title') = 0,
  'ALTER TABLE blog_posts ADD COLUMN meta_title VARCHAR(500)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'meta_description') = 0,
  'ALTER TABLE blog_posts ADD COLUMN meta_description VARCHAR(500)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'focus_keyword') = 0,
  'ALTER TABLE blog_posts ADD COLUMN focus_keyword VARCHAR(255)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'status') = 0,
  'ALTER TABLE blog_posts ADD COLUMN status VARCHAR(20) DEFAULT ''published''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'featured') = 0,
  'ALTER TABLE blog_posts ADD COLUMN featured TINYINT(1) DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'canonical_url') = 0,
  'ALTER TABLE blog_posts ADD COLUMN canonical_url VARCHAR(500)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'faqs') = 0,
  'ALTER TABLE blog_posts ADD COLUMN faqs TEXT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'active') = 0,
  'ALTER TABLE blog_posts ADD COLUMN active TINYINT(1) DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blog_posts' AND COLUMN_NAME = 'emoji') = 0,
  'ALTER TABLE blog_posts ADD COLUMN emoji VARCHAR(10) DEFAULT ''📝''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, COUNT(*) AS column_count
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('categories','coupons','admin_staff','admin_sessions','faqs','redirects','site_content','blog_posts')
GROUP BY TABLE_NAME;
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('categories','coupons','admin_staff','admin_sessions','faqs','redirects','site_content','blog_posts')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
