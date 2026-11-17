# Database migrations

These `.sql` files are for **owner review and a manual run in phpMyAdmin only**.

**The application never executes them.** Nothing under `app/`, `pages/`, `lib/` or `scripts/` reads or runs this folder, and runtime code must not create or alter tables (see `scripts/qa/check-runtime-ddl.mjs`).

## Before running any file

1. **Check the database name.** In phpMyAdmin, select the correct database in the left tree (the live shop database, not a test or local copy) and confirm its name at the top of the page before opening the SQL tab.
2. **Back up first.** Use phpMyAdmin Export (Quick, SQL) and save the file in `Web Dev\sandy-db-backups`, with the date in the file name.
3. Read the file. Every file here is written to be idempotent (`CREATE TABLE IF NOT EXISTS`), so running it twice is harmless.
4. Paste or import it in the SQL tab and run it, then confirm the table exists.

## Files

| File | Purpose |
|------|---------|
| `0001-contact-messages.sql` | Creates `contact_messages`, used by `POST /api/contact`. The API no longer creates it, so run this once before the contact form can save messages. |
| `0002-shop-schema.sql` | Reference schema for `products`, `orders`, `order_items` and `order_checkout_attempts` (checkout idempotency). The API no longer creates or alters these tables at runtime, so a fresh database needs this file. On the live shop database every object already exists, so running it changes nothing: each `CREATE` is `IF NOT EXISTS` and each `ADD COLUMN` / `ADD UNIQUE KEY` is guarded by an `INFORMATION_SCHEMA` check. It contains no seed rows, slug backfill or data updates. The duplicate-slug check just before the unique index must return no rows. |
