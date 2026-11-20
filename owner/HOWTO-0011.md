# Owner: run admin audit-log migration (0011)

**Do not run from the app.** Owner-only in phpMyAdmin. Take a backup first. The app never runs DDL.

0011 is **schema only**. It seeds nothing. Until applied, the app skips audit writes (table-missing probe) and business actions continue unchanged.

## 1. Backup

1. Open phpMyAdmin and select database **`u992747032_sandy`**.
2. Confirm the page heading names the **DATABASE** `u992747032_sandy` (not `information_schema`).
3. Use the **database-level Export** (not a single-table export).
4. Save a full SQL dump to `Web Dev\sandy-db-backups` with a timestamp in the filename.

## 2. Precheck (read-only)

0010 should already be applied on production (NEXT was 0011 at BATCH-20 start).

1. Still on database **`u992747032_sandy`**.
2. Run the `PRE-CHECK` section at the top of `0011-phpmyadmin-full.sql`.
3. Expect on a first-time run: `admin_sessions` / `admin_staff` listed; `admin_audit_log` **not** listed.
4. If objects already exist, 0011 is still safe (idempotent).

## 3. Apply 0011

1. Confirm the heading still names **DATABASE `u992747032_sandy`**.
2. Import `0011-phpmyadmin-full.sql` via the **database-level Import** (UTF-8).
3. Alternatively run `migrations/0011-admin-audit-log.sql` from the repo (it uses `DATABASE()`; prefer the phpMyAdmin file on Hostinger).
4. Re-run is a no-op.

## 4. Confirm (post-check inside the file)

- Table `admin_audit_log` exists (InnoDB, `utf8mb4_unicode_ci`) and is **empty** (row count `0`).
- Indexes: `idx_aal_created_at`, `idx_aal_entity`, `idx_aal_actor_created`, `idx_aal_action_created`.

## 5. Retention

No purge/retention job ships with 0011. Owner decides later.
