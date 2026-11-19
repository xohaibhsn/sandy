# Owner: run delivery-ops migration (0010)

**Do not run from the app.** Owner-only in phpMyAdmin. Take a backup first. The app never runs DDL.

0010 is **schema only**. It seeds nothing (no areas, riders, pickup points) and all three feature flags stay **OFF**.

## 1. Backup

1. Open phpMyAdmin and select database **`u992747032_sandy`**.
2. Confirm the page heading names the **DATABASE** `u992747032_sandy` (not `information_schema`).
3. Use the **database-level Export** (not a single-table export):
   https://auth-db1502.hstgr.io/index.php?route=/database/export&db=u992747032_sandy
4. Save a full SQL dump to `Web Dev\sandy-db-backups` with a timestamp in the filename.
5. Sanity check: the dump is expected to be **about 67 KB or larger** (same as before 0009; it only grows with data).
   A much smaller file means the export was wrong (for example a single table or the wrong database): stop and export again.

## 2. Precheck (read-only)

0009 must already be applied (`shipping_zones` is altered by 0010).

1. Still on database **`u992747032_sandy`**.
2. The `PRE-CHECK` section at the top of `0010-phpmyadmin-full.sql` is read-only. You can run just that part first
   in the SQL tab (everything above the `shipping_zones` / `shipping_areas` `CREATE TABLE` lines).
3. Expect on a first-time run:
   - `orders`, `shipping_zones` and `couriers` are listed (0009 applied).
   - `shipping_areas`, `riders` and `pickup_points` are **not** listed.
   - The column result set is empty (no `delivery_method`, `same_day_cutoff`, `fulfilment`, `shipping_area`,
     `rider_id`, `pickup_point_id`, `pickup_point_name` yet).
4. If `shipping_zones` is missing, stop: apply 0009 first. If objects already exist, 0010 is still safe (idempotent).

## 3. Apply 0010

1. Confirm the heading still names **DATABASE `u992747032_sandy`**.
2. Import `0010-phpmyadmin-full.sql` via the **database-level Import**:
   https://auth-db1502.hstgr.io/index.php?route=/database/import&db=u992747032_sandy
   (Import as **UTF-8**.)
3. Alternatively run `migrations/0010-delivery-ops.sql` from the repo (it uses `DATABASE()`; prefer the phpMyAdmin
   file on Hostinger).
4. Re-run is a no-op.

## 4. Confirm (post-check inside the file)

- Tables `shipping_areas`, `riders`, `pickup_points` exist (InnoDB, `utf8mb4_unicode_ci`) and are **empty**
  (the final row-count query shows `0, 0, 0`).
- `shipping_zones.delivery_method` `varchar(20) NOT NULL DEFAULT 'courier'` (every existing zone reads `courier`),
  `shipping_zones.same_day_cutoff` `time NULL`.
- `orders` columns `fulfilment` VARCHAR(20), `shipping_area` VARCHAR(160), `rider_id` INT, `pickup_point_id` INT,
  `pickup_point_name` VARCHAR(120), all nullable. Existing orders keep NULL; nothing is backfilled.
- Index `idx_shipping_areas_city_parent` on (`city`, `parent_id`, `active`) and unique key `uq_riders_phone`.

## 5. Flags

Leave `shipping_areas_enabled`, `shipping_restrict_to_zones` and `pickup_enabled` at **0** (absent or `"0"`).
Running 0010 changes nothing customers can see while they are off. If a flag is turned on while 0010 is missing,
the app answers 503 "Service unavailable" instead of guessing. `same_day_cutoff` is stored as a PKT wall-clock time
(owner-entered); the app does no timezone conversion.
