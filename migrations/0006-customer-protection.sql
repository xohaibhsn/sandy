-- 0006-customer-protection.sql
-- Customer blacklist, OTP challenges, and BATCH-08 customer/session tables.
-- Idempotent: CREATE TABLE IF NOT EXISTS. utf8mb4 / InnoDB. No data rows.
-- Owner review + manual run in phpMyAdmin only. The application NEVER executes this file.
--
-- Before running: confirm the database name in the phpMyAdmin header and take a backup.
-- Run after 0001–0005 (and tax SQL if building a fresh shop DB). Independent of 0007.

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'customer_blacklist',
    'otp_challenges',
    'customers',
    'customer_sessions',
    'orders'
  );

-- ========== customer_blacklist ==========
-- App enforces: at least one of phone_norm / email_norm is set (CHECK-equivalent in code).
CREATE TABLE IF NOT EXISTS customer_blacklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone_norm VARCHAR(20) NULL,
  email_norm VARCHAR(255) NULL,
  reason VARCHAR(500) NOT NULL,
  source_order_id VARCHAR(50) NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active TINYINT(1) NOT NULL DEFAULT 1,
  removed_by VARCHAR(255) NULL,
  removed_at DATETIME NULL,
  removed_reason VARCHAR(500) NULL,
  KEY idx_blacklist_active_phone (active, phone_norm),
  KEY idx_blacklist_active_email (active, email_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== otp_challenges ==========
-- No raw OTP and no raw verification token stored — hashes / provider refs only.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id CHAR(36) NOT NULL,
  phone_norm VARCHAR(20) NOT NULL,
  purpose ENUM('cod_checkout','login') NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_ref VARCHAR(128) NULL,
  status ENUM('sent','verified','expired','failed','consumed') NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  ip_hash CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  verification_token_hash CHAR(64) NULL,
  token_expires_at DATETIME NULL,
  consumed_at DATETIME NULL,
  consumed_order_id VARCHAR(50) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_otp_verification_token_hash (verification_token_hash),
  KEY idx_otp_phone_created (phone_norm, created_at),
  KEY idx_otp_ip_created (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== customers (BATCH-08 prep) ==========
CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone_norm VARCHAR(20) NOT NULL,
  email VARCHAR(255) NULL,
  email_norm VARCHAR(255) NULL,
  name VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_customers_phone_norm (phone_norm),
  KEY idx_customers_email_norm (email_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== customer_sessions (BATCH-08 prep; same security shape as admin_sessions) ==========
CREATE TABLE IF NOT EXISTS customer_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  customer_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer_sessions_token_hash (token_hash),
  KEY idx_customer_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== POST-CHECK ==========
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'customer_blacklist',
    'otp_challenges',
    'customers',
    'customer_sessions'
  )
ORDER BY TABLE_NAME;
