-- scripts/qa/fixtures/local-fixture.sql
-- Synthetic LOCAL-ONLY fixtures for scripts/qa/local-db-bootstrap.mjs.
-- Names "ZZ …", phones 0300000xxxx, emails @example.invalid. Never production data.
-- Admin staff row is inserted by the bootstrap script (password hash generated at run time).

SET NAMES utf8mb4;

-- ========== tax rules + 18% rates (parity with live rate; synthetic) ==========
INSERT INTO tax_rules (
  tax_base, shipping_taxable, rounding, tax_label, prices_include_tax, effective_from
)
SELECT 'after_discount', 0, 'per_line_whole_rupee', 'GST', 0, '2020-01-01 00:00:00'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM tax_rules LIMIT 1);

INSERT INTO tax_rates (tax_class_id, rate_percent, effective_from, created_by)
SELECT c.id, 18.0000, '2021-01-01 00:00:00', 'local-fixture'
FROM tax_classes c
WHERE NOT EXISTS (SELECT 1 FROM tax_rates LIMIT 1);

-- ========== category ==========
INSERT INTO categories (name, slug, description, active, sort_order)
SELECT 'ZZ Accessories', 'zz-accessories', 'ZZ local test category', 1, 10
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'zz-accessories');

-- ========== product Phone Case id=1 ==========
INSERT INTO products (
  id, name, slug, description, short_description, price, category, stock,
  track_inventory, stock_quantity, active, tax_class_id, requires_shipping
)
SELECT
  1,
  'Phone Case',
  'phone-case',
  'ZZ local Phone Case for e2e',
  'ZZ Phone Case',
  999.00,
  'ZZ Accessories',
  'In Stock',
  1,
  24,
  1,
  (SELECT id FROM tax_classes WHERE slug = 'physical-goods' ORDER BY id LIMIT 1),
  1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 1 OR slug = 'phone-case');

-- ========== shipping ON + zones ==========
INSERT INTO site_content (content_key, content_value, content_type, page_name, label)
SELECT 'shipping_enabled', '1', 'text', 'settings', 'shipping_enabled'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_content WHERE content_key = 'shipping_enabled');

UPDATE site_content
SET content_value = '1'
WHERE content_key = 'shipping_enabled';

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order)
SELECT 'Rest of Pakistan', NULL, NULL, 1, 500.00, 5000.00, '3-5 Days', 1, 100
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM shipping_zones WHERE name = 'Rest of Pakistan');

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order)
SELECT 'Lahore', 'Lahore', 'Punjab', 0, 200.00, 2000.00, '2 Days', 1, 10
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM shipping_zones WHERE name = 'Lahore');

-- ========== blog post ==========
INSERT INTO blog_posts (
  title, slug, excerpt, content, category, status, featured, active
)
SELECT
  'ZZ Local Post',
  'zz-local-post',
  'ZZ synthetic local blog post',
  '<p>ZZ Local Post body for local e2e.</p>',
  'Guides',
  'published',
  0,
  1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE slug = 'zz-local-post');
