-- 0001-contact-messages.sql
-- Creates the table used by POST /api/contact.
-- Idempotent: safe to run more than once. Owner review + manual run in phpMyAdmin only.
-- Definition matches what pages/api/contact.ts created at runtime before it was removed.

CREATE TABLE IF NOT EXISTS contact_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  subject VARCHAR(255),
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
