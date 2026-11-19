-- seed-delivery-ops.sql  (SANDY-BATCH-17)
-- OWNER-REVIEW seed for delivery operations. Run ONLY in phpMyAdmin on the right database (select it first,
-- the page heading must name the DATABASE), AFTER migration 0010 and a fresh backup. The application NEVER runs this file.
-- Idempotent: every INSERT is guarded by WHERE NOT EXISTS, so re-running changes nothing.
-- Does NOT touch site_content: shipping_areas_enabled, shipping_restrict_to_zones and pickup_enabled stay OFF/absent.
-- NO riders are seeded. Area names and the locality -> tehsil mapping are DRAFT (see SEED-NOTES.md): review before use.

-- ========== PRE-CHECK (read-only) ==========
SELECT DATABASE() AS current_database;
SELECT id, name, rate, free_min, estimate_text, active FROM shipping_zones WHERE name = 'Lahore' ORDER BY id;
-- Expect one ACTIVE zone named 'Lahore'. If it is missing the five Lahore sub-zones below are simply not created
-- (their rate / free_min / estimate come from that zone) and the Lahore areas are created without a pinned zone.

-- ========== 1. Lahore sub-zones (copy rate / free_min / estimate from the active zone 'Lahore') ==========
-- No cities / provinces (so no overlap with any other zone), delivery_method courier, active.
INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Lahore - Lahore City', NULL, NULL, 0, z.rate, z.free_min, z.estimate_text, 1, z.sort_order, 'courier', NULL
FROM shipping_zones z
WHERE z.name = 'Lahore' AND z.active = 1
  AND NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Lahore - Lahore City')
ORDER BY z.id LIMIT 1;

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Lahore - Lahore Cantt', NULL, NULL, 0, z.rate, z.free_min, z.estimate_text, 1, z.sort_order, 'courier', NULL
FROM shipping_zones z
WHERE z.name = 'Lahore' AND z.active = 1
  AND NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Lahore - Lahore Cantt')
ORDER BY z.id LIMIT 1;

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Lahore - Model Town', NULL, NULL, 0, z.rate, z.free_min, z.estimate_text, 1, z.sort_order, 'courier', NULL
FROM shipping_zones z
WHERE z.name = 'Lahore' AND z.active = 1
  AND NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Lahore - Model Town')
ORDER BY z.id LIMIT 1;

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Lahore - Raiwind', NULL, NULL, 0, z.rate, z.free_min, z.estimate_text, 1, z.sort_order, 'courier', NULL
FROM shipping_zones z
WHERE z.name = 'Lahore' AND z.active = 1
  AND NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Lahore - Raiwind')
ORDER BY z.id LIMIT 1;

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Lahore - Shalimar', NULL, NULL, 0, z.rate, z.free_min, z.estimate_text, 1, z.sort_order, 'courier', NULL
FROM shipping_zones z
WHERE z.name = 'Lahore' AND z.active = 1
  AND NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Lahore - Shalimar')
ORDER BY z.id LIMIT 1;

-- ========== 2. Burewala sub-zones: INACTIVE, rate 0, no free-shipping minimum, no estimate (owner sets real rates) ==========
INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Burewala - City', NULL, NULL, 0, 0, NULL, NULL, 0, 0, 'courier', NULL
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Burewala - City');

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Burewala - Surroundings 1', NULL, NULL, 0, 0, NULL, NULL, 0, 0, 'courier', NULL
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Burewala - Surroundings 1');

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Burewala - Surroundings 2', NULL, NULL, 0, 0, NULL, NULL, 0, 0, 'courier', NULL
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Burewala - Surroundings 2');

INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order, delivery_method, same_day_cutoff)
SELECT 'Burewala - Surroundings 3', NULL, NULL, 0, 0, NULL, NULL, 0, 0, 'courier', NULL
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_zones x WHERE x.name = 'Burewala - Surroundings 3');

-- ========== 3. Lahore areas: five tehsil parents (each pinned to its zone) ==========
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', 'Lahore City', NULL, (SELECT id FROM shipping_zones WHERE name = 'Lahore - Lahore City' ORDER BY id LIMIT 1), 1, 10
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Lahore' AND a.parent_id IS NULL AND a.name = 'Lahore City');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', 'Lahore Cantt', NULL, (SELECT id FROM shipping_zones WHERE name = 'Lahore - Lahore Cantt' ORDER BY id LIMIT 1), 1, 20
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Lahore' AND a.parent_id IS NULL AND a.name = 'Lahore Cantt');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', 'Model Town', NULL, (SELECT id FROM shipping_zones WHERE name = 'Lahore - Model Town' ORDER BY id LIMIT 1), 1, 30
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Lahore' AND a.parent_id IS NULL AND a.name = 'Model Town');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', 'Raiwind', NULL, (SELECT id FROM shipping_zones WHERE name = 'Lahore - Raiwind' ORDER BY id LIMIT 1), 1, 40
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Lahore' AND a.parent_id IS NULL AND a.name = 'Raiwind');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', 'Shalimar', NULL, (SELECT id FROM shipping_zones WHERE name = 'Lahore - Shalimar' ORDER BY id LIMIT 1), 1, 50
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Lahore' AND a.parent_id IS NULL AND a.name = 'Shalimar');

-- ========== 4. Lahore localities (DRAFT mapping; they inherit the tehsil's zone through the parent) ==========
-- Lahore City
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Walled City' AS name, 10 AS sort_order
  UNION ALL
  SELECT 'Bhati Gate' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Lohari Gate' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Mochi Gate' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'Delhi Gate' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'Taxali Gate' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'Shah Alami' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'Anarkali' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'Mozang' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'Chauburji' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'Gawalmandi' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'Rang Mahal' AS name, 120 AS sort_order
  UNION ALL
  SELECT 'Krishan Nagar' AS name, 130 AS sort_order
  UNION ALL
  SELECT 'Islampura' AS name, 140 AS sort_order
  UNION ALL
  SELECT 'Ichhra' AS name, 150 AS sort_order
  UNION ALL
  SELECT 'Wahdat Colony' AS name, 160 AS sort_order
  UNION ALL
  SELECT 'Qila Gujjar Singh' AS name, 170 AS sort_order
  UNION ALL
  SELECT 'Lakshmi Chowk' AS name, 180 AS sort_order
  UNION ALL
  SELECT 'Garhi Shahu' AS name, 190 AS sort_order
  UNION ALL
  SELECT 'McLeod Road' AS name, 200 AS sort_order
  UNION ALL
  SELECT 'Lytton Road' AS name, 210 AS sort_order
  UNION ALL
  SELECT 'Gulberg' AS name, 220 AS sort_order
  UNION ALL
  SELECT 'Liberty Market' AS name, 230 AS sort_order
  UNION ALL
  SELECT 'Jail Road' AS name, 240 AS sort_order
  UNION ALL
  SELECT 'Ferozepur Road' AS name, 250 AS sort_order
  UNION ALL
  SELECT 'Kalma Chowk' AS name, 260 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Lahore' AND p.parent_id IS NULL AND p.name = 'Lahore City'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Lahore' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- Lahore Cantt
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Saddar' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Cavalry Ground' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Walton' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 1' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 2' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 3' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 4' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 5' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 6' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 7' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 8' AS name, 120 AS sort_order
  UNION ALL
  SELECT 'DHA Phase 9 Prism' AS name, 130 AS sort_order
  UNION ALL
  SELECT 'Askari 10' AS name, 140 AS sort_order
  UNION ALL
  SELECT 'Askari 11' AS name, 150 AS sort_order
  UNION ALL
  SELECT 'Sarwar Road' AS name, 160 AS sort_order
  UNION ALL
  SELECT 'Fortress Stadium' AS name, 170 AS sort_order
  UNION ALL
  SELECT 'Barki Road' AS name, 180 AS sort_order
  UNION ALL
  SELECT 'Burki' AS name, 190 AS sort_order
  UNION ALL
  SELECT 'Paragon City' AS name, 200 AS sort_order
  UNION ALL
  SELECT 'Bedian Road' AS name, 210 AS sort_order
  UNION ALL
  SELECT 'Zarar Shaheed Road' AS name, 220 AS sort_order
  UNION ALL
  SELECT 'Airport Road' AS name, 230 AS sort_order
  UNION ALL
  SELECT 'Divine Gardens' AS name, 240 AS sort_order
  UNION ALL
  SELECT 'Nishat Colony' AS name, 250 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Lahore' AND p.parent_id IS NULL AND p.name = 'Lahore Cantt'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Lahore' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- Model Town
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Model Town Extension' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Muslim Town' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Faisal Town' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'Johar Town' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'Wapda Town' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'Township' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'Garden Town' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'Gulshan-e-Iqbal' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'Allama Iqbal Town' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'Shadman' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'Samanabad' AS name, 120 AS sort_order
  UNION ALL
  SELECT 'Sabzazar' AS name, 130 AS sort_order
  UNION ALL
  SELECT 'Canal View' AS name, 140 AS sort_order
  UNION ALL
  SELECT 'Valencia Town' AS name, 150 AS sort_order
  UNION ALL
  SELECT 'NFC Society' AS name, 160 AS sort_order
  UNION ALL
  SELECT 'Pak Arab Housing Society' AS name, 170 AS sort_order
  UNION ALL
  SELECT 'Thokar Niaz Baig' AS name, 180 AS sort_order
  UNION ALL
  SELECT 'Green Town' AS name, 190 AS sort_order
  UNION ALL
  SELECT 'Revenue Society' AS name, 200 AS sort_order
  UNION ALL
  SELECT 'Hamza Town' AS name, 210 AS sort_order
  UNION ALL
  SELECT 'Khayaban-e-Amin' AS name, 220 AS sort_order
  UNION ALL
  SELECT 'Nespak Housing Society' AS name, 230 AS sort_order
  UNION ALL
  SELECT 'Punjab Society' AS name, 240 AS sort_order
  UNION ALL
  SELECT 'Chungi Amar Sidhu' AS name, 250 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Lahore' AND p.parent_id IS NULL AND p.name = 'Model Town'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Lahore' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- Raiwind
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Raiwind Bypass' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Lake City' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Bahria Town Lahore' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'Bahria Orchard' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'Park View City' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'Kahna Nau' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'Jati Umra' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'Bedian Road Raiwind' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'Al-Kabir Town' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'Ali Town' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'Pine Avenue' AS name, 120 AS sort_order
  UNION ALL
  SELECT 'Manga Mandi' AS name, 130 AS sort_order
  UNION ALL
  SELECT 'Mohlanwal' AS name, 140 AS sort_order
  UNION ALL
  SELECT 'Sundar Industrial Estate' AS name, 150 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Lahore' AND p.parent_id IS NULL AND p.name = 'Raiwind'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Lahore' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- Shalimar
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Lahore', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Shalimar Gardens' AS name, 10 AS sort_order
  UNION ALL
  SELECT 'Shalimar Town' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Baghbanpura' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Mughalpura' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'Harbanspura' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'Gulshan-e-Ravi' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'Ravi Road' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'Shahdara' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'Bhatta Chowk' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'Mahmood Booti' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'Dharampura' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'Ghaziabad' AS name, 120 AS sort_order
  UNION ALL
  SELECT 'Begum Kot' AS name, 130 AS sort_order
  UNION ALL
  SELECT 'Gujjarpura' AS name, 140 AS sort_order
  UNION ALL
  SELECT 'Jallo' AS name, 150 AS sort_order
  UNION ALL
  SELECT 'Wagah' AS name, 160 AS sort_order
  UNION ALL
  SELECT 'Salamatpura' AS name, 170 AS sort_order
  UNION ALL
  SELECT 'Batapur' AS name, 180 AS sort_order
  UNION ALL
  SELECT 'Dogar Pura' AS name, 190 AS sort_order
  UNION ALL
  SELECT 'Mustafa Abad' AS name, 200 AS sort_order
  UNION ALL
  SELECT 'Bund Road' AS name, 210 AS sort_order
  UNION ALL
  SELECT 'Sanda' AS name, 220 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Lahore' AND p.parent_id IS NULL AND p.name = 'Shalimar'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Lahore' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- ========== 5. Burewala areas: city parent + surroundings ==========
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Burewala City', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - City' ORDER BY id LIMIT 1), 1, 10
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Burewala City');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Gaggo Mandi', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 1' ORDER BY id LIMIT 1), 1, 20
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Gaggo Mandi');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Shaikh Fazal', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 2' ORDER BY id LIMIT 1), 1, 30
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Shaikh Fazal');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Sahuka', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 3' ORDER BY id LIMIT 1), 1, 40
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Sahuka');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Jamlera', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 3' ORDER BY id LIMIT 1), 1, 50
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Jamlera');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Dewan Sahib', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 3' ORDER BY id LIMIT 1), 1, 60
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Dewan Sahib');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Kachi Pakki', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - Surroundings 3' ORDER BY id LIMIT 1), 1, 70
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Kachi Pakki');

INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', 'Chak 327/EB', NULL, (SELECT id FROM shipping_zones WHERE name = 'Burewala - City' ORDER BY id LIMIT 1), 1, 80
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM shipping_areas a WHERE a.city = 'Burewala' AND a.parent_id IS NULL AND a.name = 'Chak 327/EB');

-- Burewala City localities (DRAFT)
INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
SELECT 'Burewala', v.name, p.id, NULL, 1, v.sort_order
FROM (
  SELECT 'Satellite Town' AS name, 10 AS sort_order
  UNION ALL
  SELECT 'Model Town' AS name, 20 AS sort_order
  UNION ALL
  SELECT 'Gulshan-e-Iqbal Colony' AS name, 30 AS sort_order
  UNION ALL
  SELECT 'Civil Lines' AS name, 40 AS sort_order
  UNION ALL
  SELECT 'Railway Road' AS name, 50 AS sort_order
  UNION ALL
  SELECT 'Kutchery Road' AS name, 60 AS sort_order
  UNION ALL
  SELECT 'Multan Road' AS name, 70 AS sort_order
  UNION ALL
  SELECT 'Vehari Road' AS name, 80 AS sort_order
  UNION ALL
  SELECT 'Mailsi Road' AS name, 90 AS sort_order
  UNION ALL
  SELECT 'Pakpattan Road' AS name, 100 AS sort_order
  UNION ALL
  SELECT 'Ghalla Mandi' AS name, 110 AS sort_order
  UNION ALL
  SELECT 'Fawara Chowk' AS name, 120 AS sort_order
) v
JOIN shipping_areas p ON p.city = 'Burewala' AND p.parent_id IS NULL AND p.name = 'Burewala City'
WHERE NOT EXISTS (SELECT 1 FROM shipping_areas x WHERE x.city = 'Burewala' AND x.parent_id = p.id AND x.name = v.name COLLATE utf8mb4_unicode_ci);

-- ========== 6. Pickup points: TEST ONLY (active, but pickup_enabled stays OFF so customers never see them) ==========
INSERT INTO pickup_points (name, city, address, hours_text, map_url, active, sort_order)
SELECT 'ZZ Test Pickup - Lahore', 'Lahore', 'TEST ONLY - not a real pickup address. Replace or delete before enabling pickup.', 'TEST ONLY', NULL, 1, 900
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM pickup_points x WHERE x.name = 'ZZ Test Pickup - Lahore');

INSERT INTO pickup_points (name, city, address, hours_text, map_url, active, sort_order)
SELECT 'ZZ Test Pickup - Burewala', 'Burewala', 'TEST ONLY - not a real pickup address. Replace or delete before enabling pickup.', 'TEST ONLY', NULL, 1, 900
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM pickup_points x WHERE x.name = 'ZZ Test Pickup - Burewala');

-- ========== POST-CHECK (read-only) ==========
SELECT name, active, rate, free_min, estimate_text, delivery_method FROM shipping_zones WHERE name LIKE 'Lahore - %' OR name LIKE 'Burewala - %' ORDER BY name;
SELECT city, COUNT(*) AS area_rows, SUM(parent_id IS NULL) AS top_level FROM shipping_areas WHERE city IN ('Lahore','Burewala') GROUP BY city;
SELECT id, name, city, active FROM pickup_points WHERE name LIKE 'ZZ Test Pickup%';
SELECT COUNT(*) AS riders_rows FROM riders;   -- expect 0 (no riders are seeded)
SELECT content_key, content_value FROM site_content WHERE content_key IN ('shipping_areas_enabled','shipping_restrict_to_zones','pickup_enabled');   -- expect 0 rows or value 0
