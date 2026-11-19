# Database migrations

These `.sql` files are for **owner review and a manual run in phpMyAdmin only**.

**The application never executes them.** Nothing under `app/`, `pages/`, `lib/` or `scripts/` reads or runs this folder, and runtime code must not create or alter tables (see `scripts/qa/check-runtime-ddl.mjs`; its allowlist is now empty).

## Before running any file

1. **Check the database name.** In phpMyAdmin, select the correct database in the left tree (the live shop database, not a test or local copy) and confirm its name at the top of the page before opening the SQL tab.
2. **Back up first.** Use phpMyAdmin Export (Quick, SQL) and save the file in `Web Dev\sandy-db-backups`, with the date in the file name.
3. Read the file. Every file here is written to be idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ADD COLUMN`), so running it twice is harmless.
4. Paste or import it in the SQL tab and run it, then confirm the table exists. Import as **UTF-8** (0003 and 0004 contain emoji and typographic dashes).

## Files

| File | Purpose |
|------|---------|
| `0001-contact-messages.sql` | Creates `contact_messages`, used by `POST /api/contact`. For fresh databases only: production already has `contact_messages`. The API no longer creates it, so a new empty database needs this file before the contact form can save messages. |
| `0002-shop-schema.sql` | Reference schema for `products`, `orders`, `order_items` and `order_checkout_attempts` (checkout idempotency). The API no longer creates or alters these tables at runtime, so a fresh database needs this file. On the live shop database every object already exists, so running it changes nothing: each `CREATE` is `IF NOT EXISTS` and each `ADD COLUMN` / `ADD UNIQUE KEY` is guarded by an `INFORMATION_SCHEMA` check. It contains no seed rows, slug backfill or data updates. The duplicate-slug check just before the unique index must return no rows. |
| `0003-admin-schema.sql` | Schema for the admin / CMS tables: `categories`, `coupons`, `admin_staff`, `admin_sessions`, `faqs`, `redirects`, `site_content` (with `section_order`, `is_visible` and the `json` content type) and `blog_posts` (including the late `canonical_url` and `faqs` columns). Same idempotent / guarded style as 0002. **No data statements at all** (no INSERT, UPDATE, DELETE or REPLACE). Definitions are copied statement for statement from the runtime code that used to create them. Admin login needs `admin_sessions`; without it the app fails closed (503). |
| `0004-default-content-seed.sql` | Default CMS rows only: `site_content` keys, the home/about sections, and starter FAQs. **Only adds missing rows**: `INSERT IGNORE` on the unique `content_key`, FAQs inserted only when the `faqs` table is empty (the three "required" FAQs only when no FAQ has the same question). It never updates, replaces or deletes anything, so it cannot overwrite content the owner has already edited. Run it after 0003, and only when you want the default rows (a database that already has content gets just the keys it is missing). |
| `0005-orders-cancel-reason.sql` | Adds `orders.cancel_reason` (`VARCHAR(500) NULL`, after `status`) for admin cancel-reason capture. Same idempotent / guarded style as 0002. Production already has this column; the file is for fresh databases built from migrations. Run after 0002. |
| `0006-customer-protection.sql` | Creates `customer_blacklist`, `otp_challenges`, and BATCH-08 prep tables `customers` / `customer_sessions`. Idempotent `CREATE TABLE IF NOT EXISTS`. No data rows. |
| `0007-orders-protection-columns.sql` | Adds nullable COD-protection columns on `orders` (norms, risk, OTP, confirmation, advance). Guarded ADD COLUMN / indexes. No backfill — legacy rows keep NULL norms. |
| `0008-customer-accounts.sql` | Creates `customer_addresses` and `customer_wishlist`, and adds nullable `orders.customer_id` (+ index). Guarded / idempotent. No data rows, no backfill. Requires `customers` from 0006 and `orders` from 0002. |
| `0009-shipping-courier.sql` | SANDY-BATCH-12. Creates `shipping_zones` and `couriers` (no seed rows), adds `products.requires_shipping` (`TINYINT(1) NOT NULL DEFAULT 1`) and nullable `orders` columns `shipping_amount`, `shipping_zone`, `courier_id`, `tracking_number`, `shipped_at`, `delivered_at`, `rto`, `rto_at`, plus index `idx_orders_rto_phone (rto, customer_phone_norm)`. Guarded / idempotent (INFORMATION_SCHEMA + PREPARE). No backfill. Run after 0007 (the index uses `customer_phone_norm`). Harmless while `site_content.shipping_enabled` is `0` / absent. |
| `0010-delivery-ops.sql` | SANDY-BATCH-17. Creates `shipping_areas`, `riders` and `pickup_points` (no seed rows) plus index `idx_shipping_areas_city_parent (city, parent_id, active)` and unique key `uq_riders_phone`, adds `shipping_zones.delivery_method` (`VARCHAR(20) NOT NULL DEFAULT 'courier'`) and `shipping_zones.same_day_cutoff` (`TIME NULL`), and nullable `orders` columns `fulfilment`, `shipping_area`, `rider_id`, `pickup_point_id`, `pickup_point_name`. Guarded / idempotent (INFORMATION_SCHEMA + PREPARE). No backfill: existing zones read `courier`, existing orders keep NULL. Run after 0009. Harmless while `site_content.shipping_areas_enabled`, `shipping_restrict_to_zones` and `pickup_enabled` are `0` / absent. Owner steps: `owner/HOWTO-0010.md`. |

Order: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010 (0001 and 0002 are independent of 0003; 0005–0007 depend on 0002; 0006 and 0007 are independent of each other; 0008 needs 0006 + 0002; 0009 needs 0002 + 0007; 0010 needs 0009).

## Intentionally NOT ported from the removed runtime code (owner decision later)

The old request-time initialisers did more than create tables. These parts were **deliberately left out** of every migration, because they rewrite or delete existing data and must not run automatically:

- **`REPLACE` text rewrites of "IPTV" / "UK" wording** in `site_content` (`pages/api/site-content.ts`), in section JSON (`pages/api/sections.ts`) and in `blog_posts` titles, excerpts, content and meta fields (`pages/api/blog.ts`), e.g. `IPTV` becomes `Streaming`, `Premium IPTV & Streaming` becomes `Premium Streaming`.
- **The Firestick / UK clean-up `UPDATE`s** on `site_content` (contact email, WhatsApp number, phone, address, Telegram, site title/tagline, footer text), the label/`page_name` re-sync `UPDATE`s, and the `whatsapp_number` = `contact_whatsapp` copy.
- **Obsolete-FAQ `DELETE`**: the removed code deleted twelve FAQs by exact question text (for example "Do you deliver across the whole UK?", "Do Firesticks come pre-configured?", "Do you offer free trials?").
- **Other data fix-ups**: `UPDATE blog_posts SET active = 1 WHERE active IS NULL` (a newly added `active` column already defaults to 1) and the section `content_type = 'json'` repair for rows with an empty type.
- **Sample coupons `WELCOME10` and `SAVE5`** (`INSERT IGNORE` on every admin coupons request). They are live discount codes (10% off and 5 off), so they are not recreated on a fresh database. Add real coupons from the admin screen. If an old copy of the database still contains them, they stay as they are.

If the owner wants any of these, they should be written as a separate, reviewed one-off SQL script (with a backup and a `SELECT` preview of the affected rows first), never as automatic code.

## If a table is missing

Handlers no longer create tables, so a missing table is an explicit failure rather than a silent re-create:

- `admin_sessions` missing: admin login and every protected admin API answer 503 "Service unavailable" (fail closed).
- `redirects` missing: public redirect lookup is skipped (visitors are never blocked); `/api/admin-redirects` answers 503 `{"error":"Redirects storage not configured"}`.
- Any other admin table missing: that endpoint answers a generic 500 until the migration is run.
