-- 0011-phpmyadmin-full.sql
-- SANDY-BATCH-20: phpMyAdmin-safe copy of migrations/0011-admin-audit-log.sql
-- Literal schema u992747032_sandy. Qualified names. Pre/post checks.
-- Owner-only. The application NEVER executes this file. NO data rows.

USE `u992747032_sandy`;

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'u992747032_sandy'
  AND TABLE_NAME IN ('admin_audit_log', 'admin_sessions', 'admin_staff');

-- ========== admin_audit_log ==========
CREATE TABLE IF NOT EXISTS `u992747032_sandy`.`admin_audit_log` (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_type VARCHAR(10) NOT NULL,
  actor_staff_id INT NULL,
  actor_name VARCHAR(120) NULL,
  actor_role VARCHAR(30) NULL,
  action VARCHAR(40) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(120) NULL,
  summary VARCHAR(300) NOT NULL,
  detail_json TEXT NULL,
  ip_hash CHAR(64) NULL,
  user_agent VARCHAR(200) NULL,
  request_id VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log' AND INDEX_NAME = 'idx_aal_created_at') = 0,
  'ALTER TABLE `u992747032_sandy`.`admin_audit_log` ADD KEY idx_aal_created_at (created_at)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log' AND INDEX_NAME = 'idx_aal_entity') = 0,
  'ALTER TABLE `u992747032_sandy`.`admin_audit_log` ADD KEY idx_aal_entity (entity_type, entity_id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log' AND INDEX_NAME = 'idx_aal_actor_created') = 0,
  'ALTER TABLE `u992747032_sandy`.`admin_audit_log` ADD KEY idx_aal_actor_created (actor_staff_id, created_at)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log' AND INDEX_NAME = 'idx_aal_action_created') = 0,
  'ALTER TABLE `u992747032_sandy`.`admin_audit_log` ADD KEY idx_aal_action_created (action, created_at)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log';

SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'u992747032_sandy' AND TABLE_NAME = 'admin_audit_log'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

SELECT COUNT(*) AS admin_audit_log_rows FROM `u992747032_sandy`.`admin_audit_log`;
