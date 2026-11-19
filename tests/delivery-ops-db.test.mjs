/**
 * SANDY-BATCH-17 delivery operations (areas / restrict-to-zones / pickup / own rider) — DB/API integration test
 * (REAL pages/api handlers in-process, real MariaDB on 127.0.0.1:3307, dedicated DB sandy_mig_orders).
 *
 * Schema: migrations/0001..0009 + tax SQL via rebuildFromMigrations() (which does NOT include 0010), then
 * migrations/0010-delivery-ops.sql applied explicitly by this test where a section needs it.
 *
 *   A  0010 idempotent (twice, + owner phpMyAdmin variant compared structurally) and owner seed idempotent
 *   B  flag-OFF parity WITH 0010 applied (response keys, stored rows, request fingerprint)
 *   D  flags ON: area order -> zone + area snapshot; quote == order == stored
 *   E  "Other area" -> city-level zone; server-side area requirement (area_id OR other_area = true)
 *   F  restrict-to-zones: unlisted city -> deliverable:false, 409 SHIPPING_AREA_NOT_SERVED, nothing written
 *   G  pickup: shipping 0, status flow, COD confirm guard, dispatch / RTO refused, open COD counts ready_for_pickup
 *   H  own-rider zone dispatch with a rider; tracking text without the phone
 *   I  soft-deactivate on delete-in-use (areas / riders / pickup points)
 *   J  admin API validation (lengths, https map_url, PK phone, parent cycles, city mismatch)
 *   K  concurrency: duplicate area name under one parent -> exactly one wins
 *   L  RBAC / public locations endpoint
 *   C  flag-OFF parity WITHOUT 0010 (0001..0009 only), compared with B; flags ON without 0010 => 503
 *
 * Env: SANDY_TEST_DB_PASSWORD (required, never printed). DB: sandy_mig_orders (shared; do not run in parallel).
 * Run: node tests/delivery-ops-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DB_NAME,
  adminReq,
  applyDeliveryOpsMigration,
  checkoutBody,
  count,
  createPool,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  mintAdminToken,
  one,
  rebuildFromMigrations,
  requirePassword,
  root,
  runSqlOnTestDb,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetShippingSettingsCache } = await importFromRoot("lib/shippingSettings.ts");
const { resetShippingSchemaCache } = await importFromRoot("lib/shippingSchema.ts");
const { resetShippingZonesCache, AREA_NOT_SERVED_MESSAGE, AREA_REQUIRED_MESSAGE } = await importFromRoot("lib/shipping.ts");
const { resetShippingAreasCache } = await importFromRoot("lib/shippingAreas.ts");
const { resetOrderProtectionSettingsCache } = await importFromRoot("lib/orderProtectionSettings.ts");
const { loadCodRiskHistory, resetRtoColumnCache } = await importFromRoot("lib/codRisk.ts");
const { resetCancelReasonColumnCache } = await importFromRoot("lib/orderCancel.ts");

const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const taxQuoteHandler = (await importFromRoot("pages/api/tax-quote.ts")).default;
const eligibilityHandler = (await importFromRoot("pages/api/checkout/eligibility.ts")).default;
const zonesHandler = (await importFromRoot("pages/api/admin-shipping-zones.ts")).default;
const areasHandler = (await importFromRoot("pages/api/admin-shipping-areas.ts")).default;
const ridersHandler = (await importFromRoot("pages/api/admin-riders.ts")).default;
const pickupsHandler = (await importFromRoot("pages/api/admin-pickup-points.ts")).default;
const siteContentHandler = (await importFromRoot("pages/api/site-content.ts")).default;
const adminOrdersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const trackHandler = (await importFromRoot("pages/api/track.ts")).default;
const locationsHandler = (await importFromRoot("pages/api/shipping-locations.ts")).default;

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
async function section(name, fn) {
  try {
    await fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => __rateLimitTestUtils.clearStore();
let token = await mintAdminToken(pool); // re-minted by seedBase() after every rebuild (sessions are dropped with the tables)

function resetCaches() {
  resetShippingSettingsCache();
  resetShippingSchemaCache();
  resetShippingZonesCache();
  resetShippingAreasCache();
  resetOrderProtectionSettingsCache();
  resetRtoColumnCache();
  resetCancelReasonColumnCache();
}

const FLAG_KEYS = [
  "shipping_enabled",
  "shipping_areas_enabled",
  "shipping_restrict_to_zones",
  "pickup_enabled",
  "cod_protection_enabled",
];

/** Direct site_content writes (the API gates are covered separately). null deletes the key. */
async function setFlags(flags) {
  for (const [k, v] of Object.entries(flags)) {
    await pool.query("DELETE FROM site_content WHERE content_key = ?", [k]);
    if (v !== null) {
      await pool.query(
        "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES (?, ?, 'text', 'settings', ?)",
        [k, String(v), k]
      );
    }
  }
  resetCaches();
}
async function allFlagsOff() {
  await setFlags(Object.fromEntries(FLAG_KEYS.map((k) => [k, null])));
}

async function admin(handler, method, url, body, query = {}) {
  clear();
  return invoke(handler, { method, url, body, query, ...adminReq(token) });
}

const stored = (orderId) => one(pool, "SELECT * FROM orders WHERE order_id = ?", [orderId]);
const num = (v) => Number(v);

/* ------------------------------------------------------------------ fixtures */
let GOODS = 0;
let DIGITAL = 0;
let TRACKED = 0;
let _lahoreZoneId = 0;
let _defaultZoneId = 0;

/** Products + the two classic zones (same shape as shipping-db). Called after every rebuild. */
async function seedBase() {
  token = await mintAdminToken(pool);
  await pool.query(
    `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
     VALUES ('Ship Goods', 'ship-goods', 1000, 'Accessories', 'In Stock', 0, NULL, 1),
            ('Legacy Digital', 'legacy-digital', 2000, 'Accessories', 'Digital', 0, NULL, 1),
            ('Tracked Goods', 'tracked-goods', 1000, 'Accessories', '10', 1, 10, 1)`
  );
  const idOf = async (slug) => (await one(pool, "SELECT id FROM products WHERE slug = ?", [slug])).id;
  GOODS = await idOf("ship-goods");
  DIGITAL = await idOf("legacy-digital");
  TRACKED = await idOf("tracked-goods");
  await pool.query(
    `INSERT INTO shipping_zones (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order)
     VALUES ('Lahore', 'Lahore\nKasur', NULL, 0, 200, 5000, '1-2 days', 1, 1),
            ('Rest of Pakistan', NULL, NULL, 1, 450, 10000, '3-5 days', 1, 9)`
  );
  _lahoreZoneId = num((await one(pool, "SELECT id FROM shipping_zones WHERE name = 'Lahore'")).id);
  _defaultZoneId = num((await one(pool, "SELECT id FROM shipping_zones WHERE name = 'Rest of Pakistan'")).id);
  void _lahoreZoneId;
  void _defaultZoneId;
  resetCaches();
}

let seq = 0;
async function place(items, { city = "Lahore", province = "", phone, key, extra = {}, payment = "cod", noAddress = false, email } = {}) {
  clear();
  await sleep(3);
  seq += 1;
  const base = checkoutBody({
    customer_phone: phone || `0333910${String(seq).padStart(4, "0")}`,
    customer_email: email || `dops${seq}@example.test`,
    city,
    ...(province ? { province } : {}),
    items,
    payment_method: payment,
    ...(key ? { idempotency_key: key } : {}),
    ...extra,
  });
  if (noAddress) {
    delete base.delivery_address;
    delete base.city;
    delete base.postcode;
  }
  return invoke(ordersHandler, { url: "/api/orders", body: base });
}
async function quote(items, { city = "Lahore", province = "", extra = {} } = {}) {
  clear();
  return invoke(taxQuoteHandler, {
    url: "/api/tax-quote",
    body: { items, city, ...(province ? { province } : {}), ...extra },
  });
}

const OFF_ORDER_KEYS = [
  "success", "order_id", "whatsappUrl", "telegramUrl", "subtotal", "shipping", "vat_amount", "tax_label",
  "tax_lines", "discount_amount", "total", "coupon_code", "items",
];

const OPS_TABLES = ["shipping_areas", "riders", "pickup_points"];
const OPS_COLS = [
  ["shipping_zones", "delivery_method"], ["shipping_zones", "same_day_cutoff"],
  ["orders", "fulfilment"], ["orders", "shipping_area"], ["orders", "rider_id"],
  ["orders", "pickup_point_id"], ["orders", "pickup_point_name"],
];

async function opsStructure() {
  const [cols] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (TABLE_NAME IN ('shipping_areas','riders','pickup_points')
            OR (TABLE_NAME = 'shipping_zones' AND COLUMN_NAME IN ('delivery_method','same_day_cutoff'))
            OR (TABLE_NAME = 'orders' AND COLUMN_NAME IN ('fulfilment','shipping_area','rider_id','pickup_point_id','pickup_point_name')))
     ORDER BY TABLE_NAME, COLUMN_NAME`
  );
  const [idx] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('shipping_areas','riders','pickup_points')
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
  );
  const [tbl] = await pool.query(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('shipping_areas','riders','pickup_points') ORDER BY TABLE_NAME`
  );
  return JSON.parse(JSON.stringify({ cols, idx, tbl }));
}

/* ------------------------------------------------------------------ A. migration + seed */
await section("A0 owner phpMyAdmin 0010 == repo 0010 (structure)", async () => {
  await rebuildFromMigrations();
  resetCaches();
  await applyDeliveryOpsMigration();
  const repoStructure = await opsStructure();
  ok(repoStructure.cols.length >= 7 + 7 + 6 + 8, "columns exist");

  await rebuildFromMigrations();
  const owner = readFileSync(path.join(root, "owner/0010-phpmyadmin-full.sql"), "utf8");
  // The owner file names the production schema literally; substitute the dedicated TEST schema only.
  const prodSchema = "u992747032_sandy";
  ok(owner.includes(prodSchema), "owner file names its target schema");
  const localised = owner.split(prodSchema).join(DB_NAME);
  ok(!localised.includes(prodSchema));
  await runSqlOnTestDb(localised);
  await runSqlOnTestDb(localised); // idempotent too
  eq(await opsStructure(), repoStructure, "phpMyAdmin variant produces the identical structure");
});

await section("A1 migrations/0010 applied twice is a no-op", async () => {
  await rebuildFromMigrations();
  resetCaches();
  // Before 0010: nothing exists.
  for (const t of OPS_TABLES) {
    eq(await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]), 0);
  }
  await applyDeliveryOpsMigration();
  const first = await opsStructure();
  await applyDeliveryOpsMigration();
  const second = await opsStructure();
  eq(second, first, "second run changes nothing");

  for (const t of OPS_TABLES) {
    eq(await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]), 1, t);
  }
  for (const [t, c] of OPS_COLS) {
    eq(
      await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [t, c]),
      1,
      `${t}.${c}`
    );
  }
  const dm = await one(
    pool,
    "SELECT COLUMN_DEFAULT AS d, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shipping_zones' AND COLUMN_NAME = 'delivery_method'"
  );
  eq(String(dm.d).replace(/'/g, ""), "courier");
  eq(dm.n, "NO");
  for (const c of ["fulfilment", "shipping_area", "rider_id", "pickup_point_id", "pickup_point_name"]) {
    eq(
      (await one(pool, "SELECT IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?", [c])).n,
      "YES",
      `orders.${c} nullable`
    );
  }
  eq(
    await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME='riders' AND INDEX_NAME='uq_riders_phone' AND NON_UNIQUE=0) OR (TABLE_NAME='shipping_areas' AND INDEX_NAME='idx_shipping_areas_city_parent'))"),
    1 + 3,
    "uq_riders_phone (1 col) + idx_shipping_areas_city_parent (3 cols)"
  );
  // 0010 seeds no rows and does not backfill
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas"), 0);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM riders"), 0);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM pickup_points"), 0);
});

let areaIds = {};
await section("A2 owner seed twice: Lahore zones copied, Burewala inactive, 2 pickup points, 0 riders", async () => {
  await seedBase();
  const seedSql = readFileSync(path.join(root, "owner/seed-delivery-ops.sql"), "utf8");
  await runSqlOnTestDb(seedSql);
  const snapshot = async () => ({
    zones: await count(pool, "SELECT COUNT(*) AS c FROM shipping_zones"),
    areas: await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas"),
    points: await count(pool, "SELECT COUNT(*) AS c FROM pickup_points"),
    riders: await count(pool, "SELECT COUNT(*) AS c FROM riders"),
  });
  const first = await snapshot();
  await runSqlOnTestDb(seedSql);
  eq(await snapshot(), first, "second seed run inserts nothing");

  const [lz] = await pool.query("SELECT * FROM shipping_zones WHERE name LIKE 'Lahore - %' ORDER BY name");
  eq(lz.map((z) => z.name), ["Lahore - Lahore Cantt", "Lahore - Lahore City", "Lahore - Model Town", "Lahore - Raiwind", "Lahore - Shalimar"]);
  for (const z of lz) {
    eq(num(z.rate), 200, z.name);
    eq(num(z.free_min), 5000, z.name);
    eq(z.estimate_text, "1-2 days", z.name);
    eq(num(z.active), 1);
    eq(z.delivery_method, "courier");
    eq(z.cities, null, "no listed cities (no overlap with the Lahore zone)");
    eq(z.provinces, null);
    eq(num(z.is_default), 0);
  }
  const [bz] = await pool.query("SELECT * FROM shipping_zones WHERE name LIKE 'Burewala - %' ORDER BY name");
  eq(bz.map((z) => z.name), ["Burewala - City", "Burewala - Surroundings 1", "Burewala - Surroundings 2", "Burewala - Surroundings 3"]);
  for (const z of bz) {
    eq(num(z.active), 0, `${z.name} inactive`);
    eq(num(z.rate), 0);
    eq(z.free_min, null);
  }
  eq(first.points, 2);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM pickup_points WHERE name LIKE 'ZZ Test Pickup%' AND active = 1"), 2);
  eq(first.riders, 0);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE city = 'Lahore' AND parent_id IS NULL"), 5);
  ok((await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE city = 'Burewala'")) > 5);
  // the seed never touches the feature flags and the original zones are untouched
  eq(await count(pool, "SELECT COUNT(*) AS c FROM site_content WHERE content_key IN ('shipping_areas_enabled','shipping_restrict_to_zones','pickup_enabled')"), 0);
  eq(num((await one(pool, "SELECT rate AS r FROM shipping_zones WHERE name = 'Lahore'")).r), 200);

  const area = async (city, name, parent) =>
    num((await one(
      pool,
      `SELECT a.id FROM shipping_areas a LEFT JOIN shipping_areas p ON p.id = a.parent_id
       WHERE a.city = ? AND a.name = ? AND ${parent ? "p.name = ?" : "a.parent_id IS NULL AND ? = ?"} LIMIT 1`,
      parent ? [city, name, parent] : [city, name, "x", "x"]
    )).id);
  areaIds = {
    modelTown: await area("Lahore", "Model Town", null),
    johar: await area("Lahore", "Johar Town", "Model Town"),
    raiwind: await area("Lahore", "Raiwind", null),
    gaggo: await area("Burewala", "Gaggo Mandi", null),
    burewalaModel: await area("Burewala", "Model Town", "Burewala City"),
  };
  eq(num((await one(pool, "SELECT parent_id AS p FROM shipping_areas WHERE id = ?", [areaIds.johar])).p), areaIds.modelTown);
});

/* ------------------------------------------------------------------ B / C shared parity probe */
const FIXED_KEY = "11111111-2222-4333-8444-555555555555";

async function parityProbe(label) {
  const out = {};
  await allFlagsOff();

  // 1. every flag off (shipping_enabled absent): the pre-batch behaviour
  const q = await quote([{ id: GOODS, qty: 1 }], { city: "Karachi" });
  eq(q.statusCode, 200, `${label} ${JSON.stringify(q.body)}`);
  out.quoteOffKeys = Object.keys(q.body);
  eq(q.body.shipping, 0);
  for (const k of ["shipping_zone", "shipping_estimate", "shipping_area", "deliverable", "fulfilment", "pickup_enabled", "shipping_areas_enabled"]) {
    ok(!(k in q.body), `${label}: quote has no ${k} when off`);
  }
  const o = await place([{ id: GOODS, qty: 1 }], { city: "Karachi", province: "Sindh" });
  eq(o.statusCode, 200, `${label} ${JSON.stringify(o.body)}`);
  eq(Object.keys(o.body), OFF_ORDER_KEYS, `${label}: order response keys unchanged`);
  out.orderOffKeys = Object.keys(o.body);
  const row = await stored(o.body.order_id);
  eq(row.shipping_amount, null);
  eq(row.shipping_zone, null);
  if (label.includes("with 0010")) {
    // columns exist but are never written while their flags are off
    eq(row.fulfilment, null);
    eq(row.shipping_area, null);
    eq(row.rider_id, null);
    eq(row.pickup_point_id, null);
    eq(row.pickup_point_name, null);
  }

  // 2. fingerprint: fixed body, then the same key re-posted with ops-only fields => replay of the SAME order
  const fixed = {
    customer_phone: "03339990001",
    customer_email: "parity@example.test",
    city: "Lahore",
    items: [{ id: GOODS, qty: 2 }],
    idempotency_key: FIXED_KEY,
  };
  clear();
  await sleep(3);
  const a = await invoke(ordersHandler, { url: "/api/orders", body: checkoutBody(fixed) });
  eq(a.statusCode, 200, JSON.stringify(a.body));
  out.fingerprintOff = (await one(pool, "SELECT request_fingerprint AS f FROM order_checkout_attempts WHERE idempotency_key = ?", [FIXED_KEY])).f;
  clear();
  const b = await invoke(ordersHandler, {
    url: "/api/orders",
    body: checkoutBody({ ...fixed, area_id: 5, other_area: true, fulfilment: "pickup", pickup_point_id: 1 }),
  });
  eq(b.statusCode, 200, `${label}: ops-only body fields are ignored while flags are off: ${JSON.stringify(b.body)}`);
  eq(b.body.order_id, a.body.order_id, `${label}: same fingerprint => replay`);
  eq(b.body.total, a.body.total);

  // 3. shipping_enabled = 1 only (BATCH-12 behaviour): no BATCH-17 keys
  await setFlags({ shipping_enabled: "1" });
  const q1 = await quote([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { area_id: 1, other_area: true, fulfilment: "pickup" } });
  eq(q1.statusCode, 200, JSON.stringify(q1.body));
  eq(q1.body.shipping, 200);
  eq(q1.body.shipping_zone, "Lahore");
  out.quoteShipKeys = Object.keys(q1.body);
  for (const k of ["shipping_area", "deliverable", "fulfilment", "pickup_enabled", "shipping_areas_enabled", "shipping_unavailable_reason"]) {
    ok(!(k in q1.body), `${label}: quote has no ${k} with only shipping on`);
  }
  const o1 = await place([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { area_id: 1, other_area: true, fulfilment: "pickup", pickup_point_id: 1 } });
  eq(o1.statusCode, 200, JSON.stringify(o1.body));
  eq(o1.body.shipping, 200);
  eq(o1.body.shipping_zone, "Lahore");
  out.orderShipKeys = Object.keys(o1.body);
  eq(out.orderShipKeys, [...OFF_ORDER_KEYS, "shipping_zone"], `${label}: only the BATCH-12 key is added`);
  const r1 = await stored(o1.body.order_id);
  eq(num(r1.shipping_amount), 200);
  eq(r1.shipping_zone, "Lahore");
  if (label.includes("with 0010")) {
    eq(r1.fulfilment, null);
    eq(r1.shipping_area, null);
  }
  // eligibility is unaffected by the ops-only body fields too
  clear();
  const el = await invoke(eligibilityHandler, {
    url: "/api/checkout/eligibility",
    body: { phone: "03339991234", email: "elig@example.test", items: [{ id: GOODS, qty: 1 }], city: "Lahore", area_id: 3, fulfilment: "pickup" },
  });
  eq(el.statusCode, 200, JSON.stringify(el.body));

  // 4. dispatch with shipping on still behaves as BATCH-12: tracking only, rider_id is not applied w/o ops
  const d = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: o1.body.order_id, status: "dispatched", tracking_number: "PAR-1234" });
  eq(d.statusCode, 200, JSON.stringify(d.body));
  eq((await stored(o1.body.order_id)).tracking_number, "PAR-1234");
  return out;
}

let parityB = null;
await section("B flag-OFF parity WITH 0010 (areas + points seeded, flags off)", async () => {
  await applyDeliveryOpsMigration().catch(() => {});
  resetCaches();
  parityB = await parityProbe("with 0010");
  // ready_for_pickup stays a delivery-order refusal even with 0010 (409, not a new success)
  const o = await place([{ id: GOODS, qty: 1 }], { city: "Lahore" });
  const r = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: o.body.order_id, status: "ready_for_pickup" });
  eq(r.statusCode, 409, JSON.stringify(r.body));
  eq((await stored(o.body.order_id)).status, "pending");
  // public locations endpoint with everything off: minimal stable body
  clear();
  const loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations" });
  eq(loc.statusCode, 200);
  eq(loc.body, { areas_enabled: false, pickup_enabled: false });
});

/* ------------------------------------------------------------------ D. areas ON */
await section("D areas ON: area order -> stored zone + area snapshot; quote == order == stored", async () => {
  await allFlagsOff();
  await pool.query("UPDATE shipping_zones SET rate = 250 WHERE name = 'Lahore - Model Town'");
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1" });

  const items = [{ id: GOODS, qty: 1 }];
  const q = await quote(items, { city: "Lahore", extra: { area_id: areaIds.johar, other_area: false } });
  eq(q.statusCode, 200, JSON.stringify(q.body));
  eq(q.body.shipping, 250);
  eq(q.body.shipping_zone, "Lahore - Model Town");
  eq(q.body.shipping_area, "Model Town > Johar Town");
  eq(q.body.shipping_areas_enabled, true);
  ok(!("deliverable" in q.body) || q.body.deliverable !== false);

  const before = await count(pool, "SELECT COUNT(*) AS c FROM orders");
  const o = await place(items, { city: "Lahore", extra: { area_id: areaIds.johar, other_area: false } });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  eq(o.body.shipping, 250);
  eq(o.body.shipping_zone, "Lahore - Model Town");
  eq(o.body.shipping_area, "Model Town > Johar Town");
  eq(o.body.total, q.body.total, "order total == quote total");
  eq(o.body.vat_amount, q.body.vat_amount);
  eq(o.body.discount_amount, q.body.discount_amount);
  const row = await stored(o.body.order_id);
  eq(num(row.shipping_amount), 250);
  eq(row.shipping_zone, "Lahore - Model Town");
  eq(row.shipping_area, "Model Town > Johar Town");
  eq(num(row.total), o.body.total);
  eq(row.fulfilment, null, "fulfilment is only written when pickup is on");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), before + 1);
  globalThis.__dOrder = o.body.order_id;

  // free_min of the copied sub-zone (5000) applies: 5 x 1000 ships free, same everywhere
  const q5 = await quote([{ id: GOODS, qty: 5 }], { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(q5.body.shipping, 0);
  const o5 = await place([{ id: GOODS, qty: 5 }], { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(o5.statusCode, 200, JSON.stringify(o5.body));
  eq(o5.body.shipping, 0);
  eq(o5.body.total, q5.body.total);

  // zone pinned on the selected area wins over the parent's zone
  await pool.query("UPDATE shipping_areas SET zone_id = (SELECT id FROM shipping_zones WHERE name = 'Lahore - Raiwind') WHERE id = ?", [areaIds.johar]);
  resetCaches();
  const qp = await quote(items, { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(qp.body.shipping_zone, "Lahore - Raiwind");
  await pool.query("UPDATE shipping_areas SET zone_id = NULL WHERE id = ?", [areaIds.johar]);
  resetCaches();

  // an area of another city is not usable for this city: area required (never trusted on its own)
  const bad = await place(items, { city: "Lahore", extra: { area_id: areaIds.gaggo } });
  eq(bad.statusCode, 409, JSON.stringify(bad.body));
  eq(bad.body.error, AREA_REQUIRED_MESSAGE);
  // inactive area is not usable either
  await pool.query("UPDATE shipping_areas SET active = 0 WHERE id = ?", [areaIds.raiwind]);
  resetCaches();
  const inactive = await place(items, { city: "Lahore", extra: { area_id: areaIds.raiwind } });
  eq(inactive.statusCode, 409, JSON.stringify(inactive.body));
  await pool.query("UPDATE shipping_areas SET active = 1 WHERE id = ?", [areaIds.raiwind]);
  resetCaches();

  // malformed area input is a 400 (flag on only)
  for (const extra of [{ area_id: "abc" }, { area_id: 0 }, { area_id: -3 }, { area_id: 1.5 }, { area_id: [1] }, { other_area: "yes" }, { other_area: 1 }]) {
    const r = await place(items, { city: "Lahore", extra });
    eq(r.statusCode, 400, JSON.stringify(extra));
  }

  // a city without active areas: no requirement, city/default zone as before, no snapshot
  const k = await place(items, { city: "Karachi", province: "Sindh" });
  eq(k.statusCode, 200, JSON.stringify(k.body));
  eq(k.body.shipping, 450);
  eq(k.body.shipping_zone, "Rest of Pakistan");
  eq(k.body.shipping_area, null);

  // digital-only baskets never need an area
  const dg = await place([{ id: DIGITAL, qty: 1 }], { city: "Lahore" });
  eq(dg.statusCode, 200, JSON.stringify(dg.body));
  eq(dg.body.shipping, 0);

  // idempotent replay returns the stored snapshot
  const key = crypto.randomUUID();
  const r1 = await place(items, { city: "Lahore", phone: "03337770777", key, email: "replay-d@example.test", extra: { area_id: areaIds.johar } });
  eq(r1.statusCode, 200, JSON.stringify(r1.body));
  await pool.query("UPDATE shipping_zones SET rate = 999 WHERE name = 'Lahore - Model Town'");
  resetCaches();
  const r2 = await place(items, { city: "Lahore", phone: "03337770777", key, email: "replay-d@example.test", extra: { area_id: areaIds.johar } });
  eq(r2.statusCode, 200, JSON.stringify(r2.body));
  eq(r2.body.order_id, r1.body.order_id);
  eq(r2.body.shipping, 250, "replay shows stored shipping, not the new rate");
  eq(r2.body.shipping_area, "Model Town > Johar Town");
  await pool.query("UPDATE shipping_zones SET rate = 250 WHERE name = 'Lahore - Model Town'");
  resetCaches();
});

/* ------------------------------------------------------------------ E. other area + server-side requirement */
await section("E Other area -> city-level zone; area_id OR explicit other_area required", async () => {
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1" });
  const items = [{ id: GOODS, qty: 1 }];

  const q = await quote(items, { city: "Lahore", extra: { other_area: true } });
  eq(q.statusCode, 200, JSON.stringify(q.body));
  eq(q.body.shipping, 200);
  eq(q.body.shipping_zone, "Lahore");
  eq(q.body.shipping_area, null);
  const o = await place(items, { city: "Lahore", extra: { other_area: true } });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  eq(o.body.shipping, 200);
  eq(o.body.shipping_zone, "Lahore", "city-level Lahore zone");
  eq(o.body.shipping_area, null);
  eq(o.body.total, q.body.total);
  const row = await stored(o.body.order_id);
  eq(num(row.shipping_amount), 200);
  eq(row.shipping_zone, "Lahore");
  eq(row.shipping_area, null);

  // other_area = true wins over a stray area_id (the cart never sends both)
  const both = await place(items, { city: "Lahore", extra: { other_area: true, area_id: areaIds.johar } });
  eq(both.statusCode, 200, JSON.stringify(both.body));
  eq(both.body.shipping_area, null);
  eq(both.body.shipping_zone, "Lahore");

  // REQUIRED: the city has active areas and the client sends neither a valid area_id nor other_area=true
  const orders0 = await count(pool, "SELECT COUNT(*) AS c FROM orders");
  const att0 = await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts");
  const items0 = await count(pool, "SELECT COUNT(*) AS c FROM order_items");
  for (const extra of [{}, { area_id: null }, { area_id: "" }, { other_area: false }, { area_id: 999999 }]) {
    const r = await place(items, { city: "Lahore", extra });
    eq(r.statusCode, 409, `${JSON.stringify(extra)} => ${JSON.stringify(r.body)}`);
    eq(r.body.error, AREA_REQUIRED_MESSAGE);
  }
  // city match is normalised (case / whitespace)
  eq((await place(items, { city: "  lAhOrE " })).statusCode, 409);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), orders0, "no order rows written");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"), att0, "attempt claim rolled back");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items"), items0);

  // tax-quote stays advisory (the cart blocks the button itself): never a hard failure
  const adv = await quote(items, { city: "Lahore" });
  eq(adv.statusCode, 200);
  ok(!("deliverable" in adv.body));

  // Burewala has areas too; a listed Burewala area pinned to an INACTIVE zone is skipped -> default zone
  const bw = await place(items, { city: "Burewala", province: "Punjab", extra: { area_id: areaIds.gaggo } });
  eq(bw.statusCode, 200, JSON.stringify(bw.body));
  eq(bw.body.shipping_zone, "Rest of Pakistan", "inactive zones are never used");
  eq(bw.body.shipping_area, "Gaggo Mandi");

  // flag OFF again: area fields are ignored and nothing is required
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: null });
  const off = await place(items, { city: "Lahore" });
  eq(off.statusCode, 200, JSON.stringify(off.body));
  ok(!("shipping_area" in off.body));
  eq(off.body.shipping_zone, "Lahore");
});

/* ------------------------------------------------------------------ F. restrict-to-zones */
await section("F restrict ON + unlisted city -> deliverable:false, 409 SHIPPING_AREA_NOT_SERVED, no rows", async () => {
  await allFlagsOff();
  await setFlags({ shipping_enabled: "1" });
  // enabling restrict through the real site-content API (gate: a zone lists cities)
  let r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_restrict_to_zones", value: "1" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  resetCaches();
  const items = [{ id: TRACKED, qty: 2 }];
  const stock = async () => num((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q);
  const stock0 = await stock();

  const q = await quote(items, { city: "Karachi", province: "Sindh" });
  eq(q.statusCode, 200, JSON.stringify(q.body));
  eq(q.body.deliverable, false);
  eq(q.body.shipping_unavailable_reason, AREA_NOT_SERVED_MESSAGE);
  eq(q.body.shipping, 0);

  const orders0 = await count(pool, "SELECT COUNT(*) AS c FROM orders");
  const att0 = await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts");
  const lines0 = await count(pool, "SELECT COUNT(*) AS c FROM order_items");
  const snaps0 = await count(pool, "SELECT COUNT(*) AS c FROM order_tax_snapshots");
  const o = await place(items, { city: "Karachi", province: "Sindh" });
  eq(o.statusCode, 409, JSON.stringify(o.body));
  eq(o.body.error, AREA_NOT_SERVED_MESSAGE);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), orders0, "no order");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"), att0, "no attempt row");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items"), lines0, "no items");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM order_tax_snapshots"), snaps0, "no tax snapshot");
  eq(await stock(), stock0, "stock untouched");

  // a listed city still works and agrees with its quote
  const ql = await quote(items, { city: "Lahore" });
  eq(ql.body.shipping, 200);
  ok(ql.body.deliverable !== false);
  const ol = await place(items, { city: "Lahore" });
  eq(ol.statusCode, 200, JSON.stringify(ol.body));
  eq(ol.body.total, ql.body.total);
  eq(ol.body.shipping_zone, "Lahore");
  eq(await stock(), stock0 - 2);
  // province-only listing is not set up here; eligibility never fails on a refusal
  clear();
  const el = await invoke(eligibilityHandler, {
    url: "/api/checkout/eligibility",
    body: { phone: "03339991299", email: "elig3@example.test", items: [{ id: GOODS, qty: 1 }], city: "Karachi" },
  });
  eq(el.statusCode, 200, JSON.stringify(el.body));

  // restrict + areas: Burewala city is unlisted, the selected area is pinned to an inactive zone => refused
  await setFlags({ shipping_enabled: "1", shipping_restrict_to_zones: "1", shipping_areas_enabled: "1" });
  const qb = await quote([{ id: GOODS, qty: 1 }], { city: "Burewala", extra: { area_id: areaIds.gaggo } });
  eq(qb.body.deliverable, false);
  const ob = await place([{ id: GOODS, qty: 1 }], { city: "Burewala", extra: { area_id: areaIds.gaggo } });
  eq(ob.statusCode, 409, JSON.stringify(ob.body));
  eq(ob.body.error, AREA_NOT_SERVED_MESSAGE);
  // ...but an area pinned to an ACTIVE zone is served even though the city is unlisted
  const qm = await quote([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(qm.body.shipping_zone, "Lahore - Model Town");
  ok(qm.body.deliverable !== false);

  // restrict can not be enabled when nothing could match
  await allFlagsOff();
  await pool.query("UPDATE shipping_zones SET cities = NULL, provinces = NULL");
  resetCaches();
  r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_restrict_to_zones", value: "1" });
  eq(r.statusCode, 400, JSON.stringify(r.body));
  await pool.query("UPDATE shipping_zones SET cities = 'Lahore\nKasur' WHERE name = 'Lahore'");
  resetCaches();
});

/* ------------------------------------------------------------------ G. pickup */
let pickupPointId = 0;
await section("G pickup: shipping 0, status flow, COD guard, dispatch/RTO refused", async () => {
  await allFlagsOff();
  await setFlags({ shipping_enabled: "1", pickup_enabled: "1" });
  pickupPointId = num((await one(pool, "SELECT id FROM pickup_points WHERE name = 'ZZ Test Pickup - Lahore'")).id);
  const items = [{ id: GOODS, qty: 1 }];
  const phone = "03338880100";

  const q = await quote(items, { city: "Lahore", extra: { fulfilment: "pickup", pickup_point_id: pickupPointId } });
  eq(q.statusCode, 200, JSON.stringify(q.body));
  eq(q.body.shipping, 0);
  eq(q.body.fulfilment, "pickup");
  eq(q.body.pickup_enabled, true);

  const o = await place(items, { phone, noAddress: true, extra: { fulfilment: "pickup", pickup_point_id: pickupPointId } });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  eq(o.body.shipping, 0);
  eq(o.body.fulfilment, "pickup");
  eq(o.body.pickup_point_name, "ZZ Test Pickup - Lahore");
  eq(o.body.total, q.body.total, "pickup: quote == order");
  const id = o.body.order_id;
  await pool.query("UPDATE orders SET customer_phone_norm = ? WHERE order_id = ?", [phone, id]); // protection is off at placement
  const row = await stored(id);
  eq(row.fulfilment, "pickup");
  eq(num(row.pickup_point_id), pickupPointId);
  eq(row.pickup_point_name, "ZZ Test Pickup - Lahore");
  eq(num(row.shipping_amount), 0);
  eq(row.shipping_zone, null);

  // invalid pickup requests: no / unknown / inactive point
  for (const extra of [{ fulfilment: "pickup" }, { fulfilment: "pickup", pickup_point_id: 987654 }, { fulfilment: "courier" }]) {
    const r = await place(items, { noAddress: true, extra });
    eq(r.statusCode, 400, JSON.stringify(extra));
  }
  await pool.query("UPDATE pickup_points SET active = 0 WHERE id = ?", [pickupPointId]);
  resetCaches();
  eq((await place(items, { noAddress: true, extra: { fulfilment: "pickup", pickup_point_id: pickupPointId } })).statusCode, 400);
  await pool.query("UPDATE pickup_points SET active = 1 WHERE id = ?", [pickupPointId]);
  resetCaches();
  // delivery still works with pickup on (fulfilment defaults to delivery) and records fulfilment = delivery
  const dl = await place(items, { city: "Lahore" });
  eq(dl.statusCode, 200, JSON.stringify(dl.body));
  eq(dl.body.fulfilment, "delivery");
  eq(dl.body.pickup_point_name, null);
  eq(dl.body.shipping, 200);
  eq((await stored(dl.body.order_id)).fulfilment, "delivery");

  // status flow with COD protection ON: the guard needs a confirmation first
  await setFlags({ shipping_enabled: "1", pickup_enabled: "1", cod_protection_enabled: "1" });
  const patch = (orderId, body) => admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: orderId, ...body });
  let r = await patch(id, { status: "ready_for_pickup" });
  eq(r.statusCode, 409, JSON.stringify(r.body));
  eq(r.body.code, "COD_CONFIRMATION_REQUIRED");
  eq((await stored(id)).status, "pending");
  r = await patch(id, { status: "dispatched" });
  eq(r.statusCode, 409, "pickup orders cannot be dispatched");
  eq((await stored(id)).status, "pending");
  r = await patch(id, { status: "confirmed", confirmation_method: "call", confirmation_note: "ok" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq((await stored(id)).status, "confirmed");

  // COD risk: a confirmed pickup COD order is OPEN
  const norm = (await stored(id)).customer_phone_norm;
  ok(norm, "phone norm stored");
  resetRtoColumnCache();
  let hist = await loadCodRiskHistory(pool, norm);
  eq(hist.openCodPendingCount, 1, "confirmed COD counts as open");

  r = await patch(id, { status: "dispatched" });
  eq(r.statusCode, 409, JSON.stringify(r.body));
  ok(r.body.code && /DISPATCH/i.test(r.body.code) || /dispatch/i.test(String(r.body.error)), JSON.stringify(r.body));
  r = await patch(id, { status: "ready_for_pickup" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq((await stored(id)).status, "ready_for_pickup");
  // ready_for_pickup is still OPEN for COD risk (fix 1)
  hist = await loadCodRiskHistory(pool, norm);
  eq(hist.openCodPendingCount, 1, "ready_for_pickup COD counts as open");

  // dispatch / RTO refused for pickup, even though dispatch is normally the way to RTO
  r = await patch(id, { status: "dispatched" });
  eq(r.statusCode, 409);
  r = await patch(id, { action: "rto" });
  eq(r.statusCode, 409, JSON.stringify(r.body));
  eq((await stored(id)).status, "ready_for_pickup");
  eq((await stored(id)).rto, null);

  // public tracking text
  clear();
  const email = (await stored(id)).customer_email;
  let t = await invoke(trackHandler, { url: "/api/track", body: { order_id: id, email } });
  eq(t.statusCode, 200, JSON.stringify(t.body));
  eq(t.body.order.fulfilment, "pickup");
  ok(String(t.body.order.status_label).startsWith("Ready for pickup at ZZ Test Pickup - Lahore"), t.body.order.status_label);
  eq(t.body.order.pickup_point.name, "ZZ Test Pickup - Lahore");

  r = await patch(id, { status: "delivered" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const done = await stored(id);
  eq(done.status, "delivered");
  ok(done.delivered_at);
  hist = await loadCodRiskHistory(pool, norm);
  eq(hist.openCodPendingCount, 0, "delivered is no longer open");
  eq(hist.deliveredCount, 1);
  clear();
  t = await invoke(trackHandler, { url: "/api/track", body: { order_id: id, email } });
  eq(t.body.order.status_label, "Picked up");

  // a delivery order can never be ready_for_pickup
  r = await patch(dl.body.order_id, { status: "ready_for_pickup" });
  eq(r.statusCode, 409, JSON.stringify(r.body));

  // pickup + prepaid: no COD gate, ready_for_pickup straight from pending
  const pp = await place(items, { phone: "03338880101", noAddress: true, payment: "bank", extra: { fulfilment: "pickup", pickup_point_id: pickupPointId, payment_reference: "REF-12345" } });
  eq(pp.statusCode, 200, JSON.stringify(pp.body));
  r = await patch(pp.body.order_id, { status: "ready_for_pickup" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  await setFlags({ shipping_enabled: "1", pickup_enabled: "1", cod_protection_enabled: null });
});

/* ------------------------------------------------------------------ H. own rider */
let riderId = 0;
await section("H own-rider zone dispatch with rider; tracking text without the phone", async () => {
  await allFlagsOff();
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1" });
  const RIDER_PHONE = "03451234567";

  let r = await admin(ridersHandler, "POST", "/api/admin-riders", { name: "Ali Raza", phone: RIDER_PHONE, sort_order: 1 });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  riderId = r.body.id;
  r = await admin(ridersHandler, "POST", "/api/admin-riders", { name: "Dormant Rider", phone: "03451234568", active: 0 });
  const dormantRider = r.body.id;

  const modelZone = num((await one(pool, "SELECT id FROM shipping_zones WHERE name = 'Lahore - Model Town'")).id);
  r = await admin(zonesHandler, "PATCH", "/api/admin-shipping-zones", { id: modelZone, delivery_method: "own_rider", same_day_cutoff: "15:00" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  r = await admin(zonesHandler, "PATCH", "/api/admin-shipping-zones", { id: modelZone, same_day_cutoff: "25:99" });
  eq(r.statusCode, 400, "bad cutoff");
  r = await admin(zonesHandler, "PATCH", "/api/admin-shipping-zones", { id: modelZone, delivery_method: "drone" });
  eq(r.statusCode, 400, "bad delivery method");
  resetCaches();

  const items = [{ id: GOODS, qty: 1 }];
  const q = await quote(items, { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(q.body.shipping_zone, "Lahore - Model Town");
  eq(q.body.shipping_estimate, "Same-day delivery for orders before 15:00");
  const o = await place(items, { city: "Lahore", phone: "03338880200", extra: { area_id: areaIds.johar } });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  eq(o.body.total, q.body.total);
  const id = o.body.order_id;
  const patch = (body) => admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id, ...body });

  r = await patch({ status: "dispatched", rider_id: dormantRider });
  eq(r.statusCode, 400, "inactive rider");
  r = await patch({ status: "dispatched", rider_id: 987654 });
  eq(r.statusCode, 400, "unknown rider");
  r = await patch({ status: "dispatched", rider_id: "abc" });
  eq(r.statusCode, 400, "malformed rider");
  eq((await stored(id)).status, "pending", "invalid dispatch changed nothing");

  r = await patch({ status: "dispatched", rider_id: riderId });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const row = await stored(id);
  eq(row.status, "dispatched");
  eq(num(row.rider_id), riderId);
  eq(row.tracking_number, null, "tracking number optional for own-rider delivery");
  ok(row.shipped_at, "shipped_at set");

  clear();
  const t = await invoke(trackHandler, { url: "/api/track", body: { order_id: id, email: row.customer_email } });
  eq(t.statusCode, 200, JSON.stringify(t.body));
  eq(t.body.order.status_label, "Out for delivery with our rider (Ali)");
  const text = JSON.stringify(t.body);
  ok(!text.includes(RIDER_PHONE) && !text.includes(RIDER_PHONE.slice(1)), "rider phone is never exposed");
  ok(!text.includes("Raza"), "first name only");
  ok(!("rider_id" in t.body.order), "no rider id key");

  // RTO of a dispatched DELIVERY order still works and keeps the rider history
  r = await patch({ action: "rto" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(num((await stored(id)).rto), 1);
  eq(num((await stored(id)).rider_id), riderId);

  // zone back to courier: estimate returns to the zone text
  r = await admin(zonesHandler, "PATCH", "/api/admin-shipping-zones", { id: modelZone, delivery_method: "courier", same_day_cutoff: null });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  resetCaches();
  const q2 = await quote(items, { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(q2.body.shipping_estimate, "1-2 days");
  globalThis.__dormantRider = dormantRider;
  globalThis.__riderOrder = id;
});

/* ------------------------------------------------------------------ I. soft deactivate */
await section("I delete-in-use soft-deactivates (areas / riders / pickup points)", async () => {
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1", pickup_enabled: "1" });
  const del = (handler, url, id) => admin(handler, "DELETE", url, { id });

  // areas: parent with children => 409; used leaf => deactivated; unused leaf => deleted
  let r = await del(areasHandler, "/api/admin-shipping-areas", areaIds.modelTown);
  eq(r.statusCode, 409, JSON.stringify(r.body));
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE id = ?", [areaIds.modelTown]), 1);
  r = await del(areasHandler, "/api/admin-shipping-areas", areaIds.johar);
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(r.body.deactivated, true);
  eq(r.body.deleted, false);
  eq(num((await one(pool, "SELECT active AS a FROM shipping_areas WHERE id = ?", [areaIds.johar])).a), 0);
  ok((await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE shipping_area = 'Model Town > Johar Town'")) > 0, "history kept");
  // a deactivated area is no longer selectable (and not in the public list)
  const rq = await place([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { area_id: areaIds.johar } });
  eq(rq.statusCode, 409, JSON.stringify(rq.body));
  clear();
  const loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations", query: { city: "Lahore" } });
  eq(loc.statusCode, 200, JSON.stringify(loc.body));
  ok(!loc.body.areas.some((a) => a.id === areaIds.johar), "inactive hidden from the public list");
  r = await admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: "Lahore", name: "Unused Block", parent_id: areaIds.modelTown });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  r = await del(areasHandler, "/api/admin-shipping-areas", r.body.id);
  eq(r.body.deleted, true);
  eq(r.body.deactivated, false);
  r = await del(areasHandler, "/api/admin-shipping-areas", 987654);
  eq(r.statusCode, 404);

  // riders
  r = await del(ridersHandler, "/api/admin-riders", riderId);
  eq(r.statusCode, 200);
  eq(r.body.deactivated, true, "rider referenced by orders.rider_id");
  eq(num((await one(pool, "SELECT active AS a FROM riders WHERE id = ?", [riderId])).a), 0);
  r = await del(ridersHandler, "/api/admin-riders", globalThis.__dormantRider);
  eq(r.body.deleted, true, "unused rider is deleted");
  eq(await count(pool, "SELECT COUNT(*) AS c FROM riders WHERE id = ?", [globalThis.__dormantRider]), 0);
  r = await del(ridersHandler, "/api/admin-riders", 987654);
  eq(r.statusCode, 404);

  // pickup points
  r = await del(pickupsHandler, "/api/admin-pickup-points", pickupPointId);
  eq(r.statusCode, 200);
  eq(r.body.deactivated, true, "point referenced by orders.pickup_point_id");
  eq(num((await one(pool, "SELECT active AS a FROM pickup_points WHERE id = ?", [pickupPointId])).a), 0);
  const other = num((await one(pool, "SELECT id FROM pickup_points WHERE name = 'ZZ Test Pickup - Burewala'")).id);
  r = await del(pickupsHandler, "/api/admin-pickup-points", other);
  eq(r.body.deleted, true);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM pickup_points WHERE id = ?", [other]), 0);
  r = await del(pickupsHandler, "/api/admin-pickup-points", 987654);
  eq(r.statusCode, 404);
});

/* ------------------------------------------------------------------ J. API validation */
await section("J admin API validation", async () => {
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1" });
  const A = (m, body, query) => admin(areasHandler, m, "/api/admin-shipping-areas", body, query);

  // ---- areas
  let r = await A("POST", { city: "Faisalabad", name: "Peoples Colony" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const parent = r.body.id;
  r = await A("POST", { city: "Faisalabad", name: "Block A", parent_id: parent });
  eq(r.statusCode, 200);
  const child = r.body.id;
  r = await A("POST", { city: "Faisalabad", name: "Sub A1", parent_id: child });
  eq(r.statusCode, 200);
  const grandchild = r.body.id;

  const bad = [
    [{ city: "Faisalabad", name: "" }, "empty name"],
    [{ city: "Faisalabad", name: "   " }, "blank name"],
    [{ city: "Faisalabad", name: "x".repeat(121) }, "name too long"],
    [{ city: "Faisalabad", name: "<b>x</b>" }, "html in name"],
    [{ city: "Faisalabad", name: "bell\u0007" }, "control char"],
    [{ city: "Faisalabad", name: 42 }, "non-string name"],
    [{ city: "", name: "NoCity" }, "empty city"],
    [{ city: "c".repeat(101), name: "LongCity" }, "city too long"],
    [{ name: "NoCityKey" }, "missing city"],
    [{ city: "Faisalabad", name: "Bad parent", parent_id: 987654 }, "unknown parent"],
    [{ city: "Faisalabad", name: "Bad parent", parent_id: "abc" }, "malformed parent"],
    [{ city: "Lahore", name: "City mismatch", parent_id: parent }, "parent in another city"],
    [{ city: "Faisalabad", name: "Bad zone", zone_id: 987654 }, "unknown zone"],
    [{ city: "Faisalabad", name: "Bad active", active: "maybe" }, "invalid active"],
    [{ city: "Faisalabad", name: "Bad sort", sort_order: -1 }, "negative sort"],
    [{ city: "Faisalabad", name: "Bad sort", sort_order: 100001 }, "sort too large"],
  ];
  for (const [body, why] of bad) {
    r = await A("POST", body);
    eq(r.statusCode, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE city IN ('Faisalabad','') AND name IN ('Bad parent','City mismatch','NoCity','Bad zone','Bad active','Bad sort')"), 0);
  r = await A("POST", { city: " faisalabad ", name: " peoples colony " });
  eq(r.statusCode, 409, "duplicate (normalised) under the same parent");
  // same name under a different parent is fine
  r = await A("POST", { city: "Faisalabad", name: "Peoples Colony", parent_id: parent });
  eq(r.statusCode, 200, JSON.stringify(r.body));

  // parent cycles + city mismatch on PATCH
  r = await A("PATCH", { id: parent, parent_id: parent });
  eq(r.statusCode, 400, "own parent");
  r = await A("PATCH", { id: parent, parent_id: grandchild });
  eq(r.statusCode, 400, "descendant as parent");
  r = await A("PATCH", { id: parent, parent_id: child });
  eq(r.statusCode, 400, "child as parent");
  r = await A("PATCH", { id: grandchild, city: "Karachi" });
  eq(r.statusCode, 400, "city change that breaks the parent city rule");
  r = await A("PATCH", { id: child, parent_id: null });
  eq(r.statusCode, 200, "moving to the top level is fine");
  r = await A("PATCH", { id: child, parent_id: parent });
  eq(r.statusCode, 200, "and back");
  r = await A("PATCH", { id: 987654, name: "Ghost" });
  eq(r.statusCode, 404);
  r = await A("PATCH", { id: child });
  eq(r.statusCode, 400, "nothing to update");
  r = await A("PATCH", { id: child, name: "Peoples Colony" });
  eq(r.statusCode, 409, "rename collides with a sibling name under that parent");

  // bulk
  r = await A("POST", { action: "bulk", city: "Faisalabad", parent_id: parent, names: ["Block A", "Block B", "  ", "Block B", "y".repeat(121), "Block C"] });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(r.body.created.length, 2, "Block B + Block C");
  ok(r.body.skipped.includes("Block A"), "existing name skipped");
  r = await A("POST", { action: "bulk", city: "Faisalabad", names: [] });
  eq(r.statusCode, 400);
  r = await A("POST", { action: "bulk", city: "Faisalabad", names: Array.from({ length: 201 }, (_, i) => `N${i}`) });
  eq(r.statusCode, 400, "too many names");
  r = await A("POST", { action: "bulk", city: "Faisalabad", names: "nope" });
  eq(r.statusCode, 400);
  r = await A("POST", { action: "bulk", city: "Lahore", parent_id: parent, names: ["X"] });
  eq(r.statusCode, 400, "bulk parent in another city");
  r = await A("GET", undefined, { city: " FAISALABAD" });
  eq(r.statusCode, 200);
  ok(r.body.areas.length >= 6 && r.body.areas.every((a) => a.city === "Faisalabad"));
  r = await admin(areasHandler, "PUT", "/api/admin-shipping-areas", {});
  eq(r.statusCode, 405);

  // ---- pickup points
  const P = (m, body) => admin(pickupsHandler, m, "/api/admin-pickup-points", body);
  const okPoint = { name: "Main Store", city: "Lahore", address: "1 Mall Road", hours_text: "10-6", map_url: "https://maps.example/store" };
  r = await P("POST", okPoint);
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const pid = r.body.id;
  eq((await one(pool, "SELECT map_url AS m FROM pickup_points WHERE id = ?", [pid])).m, "https://maps.example/store");
  const badPoints = [
    [{ ...okPoint, name: "" }, "empty name"],
    [{ ...okPoint, name: "n".repeat(121) }, "name too long"],
    [{ ...okPoint, city: "" }, "empty city"],
    [{ ...okPoint, city: "c".repeat(101) }, "city too long"],
    [{ ...okPoint, address: "" }, "empty address"],
    [{ ...okPoint, address: "a".repeat(301) }, "address too long"],
    [{ ...okPoint, hours_text: "h".repeat(121) }, "hours too long"],
    [{ ...okPoint, map_url: "http://maps.example/store" }, "http map"],
    [{ ...okPoint, map_url: "javascript:alert(1)" }, "javascript map"],
    [{ ...okPoint, map_url: "ftp://maps.example/x" }, "ftp map"],
    [{ ...okPoint, map_url: "https://" }, "https without host"],
    [{ ...okPoint, map_url: "not a url" }, "garbage map"],
    [{ ...okPoint, map_url: `https://maps.example/${"p".repeat(500)}` }, "map too long"],
    [{ ...okPoint, name: "<script>" }, "html name"],
    [{ ...okPoint, active: "maybe" }, "bad active"],
  ];
  for (const [body, why] of badPoints) {
    r = await P("POST", body);
    eq(r.statusCode, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  r = await P("PATCH", { id: pid, map_url: "http://insecure.example" });
  eq(r.statusCode, 400);
  r = await P("PATCH", { id: pid, map_url: "" });
  eq(r.statusCode, 200, "clearing the map link is fine");
  eq((await one(pool, "SELECT map_url AS m FROM pickup_points WHERE id = ?", [pid])).m, null);
  r = await P("PATCH", { id: pid });
  eq(r.statusCode, 400);
  r = await P("PATCH", { id: 987654, name: "Ghost" });
  eq(r.statusCode, 404);

  // ---- riders
  const R = (m, body) => admin(ridersHandler, m, "/api/admin-riders", body);
  r = await R("POST", { name: "Bilal Khan", phone: "+92 300 1234567" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const bilal = r.body.id;
  eq((await one(pool, "SELECT phone AS p FROM riders WHERE id = ?", [bilal])).p, "03001234567", "phone stored canonical");
  r = await R("POST", { name: "Dup", phone: "0300-1234567" });
  eq(r.statusCode, 409, "same canonical phone");
  for (const [body, why] of [
    [{ name: "", phone: "03001234569" }, "empty name"],
    [{ name: "n".repeat(101), phone: "03001234569" }, "name too long"],
    [{ name: "<b>", phone: "03001234569" }, "html name"],
    [{ name: "NoPhone" }, "missing phone"],
    [{ name: "Short", phone: "12345" }, "short phone"],
    [{ name: "Landline", phone: "04235761234" }, "landline"],
    [{ name: "Letters", phone: "03ab1234567" }, "letters"],
    [{ name: "Intl", phone: "+14155550123" }, "non-PK"],
    [{ name: "Bad active", phone: "03001234569", active: "maybe" }, "bad active"],
  ]) {
    r = await R("POST", body);
    eq(r.statusCode, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  r = await R("PATCH", { id: bilal, phone: "123" });
  eq(r.statusCode, 400);
  r = await R("POST", { name: "Second", phone: "03001234570" });
  r = await R("PATCH", { id: r.body.id, phone: "03001234567" });
  eq(r.statusCode, 409, "PATCH to a taken phone");
  r = await R("PATCH", { id: 987654, name: "Ghost" });
  eq(r.statusCode, 404);
  r = await R("GET");
  eq(r.statusCode, 200);
  ok(r.body.riders.every((x) => !("created_at" in x)));

  globalThis.__areasTree = { parent };
});

/* ------------------------------------------------------------------ K. concurrency */
await section("K concurrent duplicate area name under one parent -> exactly one wins", async () => {
  const parent = globalThis.__areasTree.parent;
  clear();
  const mk = () => admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: "Faisalabad", name: "Race Block", parent_id: parent });
  const results = await Promise.all([mk(), mk(), mk()]);
  const wins = results.filter((x) => x.statusCode === 200);
  const conflicts = results.filter((x) => x.statusCode === 409);
  eq(wins.length, 1, `statuses ${results.map((x) => x.statusCode)}`);
  eq(conflicts.length, 2, `statuses ${results.map((x) => x.statusCode)}`);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE parent_id = ? AND name = 'Race Block'", [parent]), 1);

  // top level too (parent NULL, differently cased / spaced name)
  const top = await Promise.all([
    admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: "Gujranwala", name: "Race Top" }),
    admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: " gujranwala", name: " race top " }),
  ]);
  eq(top.filter((x) => x.statusCode === 200).length, 1, `statuses ${top.map((x) => x.statusCode)}`);
  eq(top.filter((x) => x.statusCode === 409).length, 1);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE city = 'Gujranwala' AND parent_id IS NULL"), 1);

  // two concurrent renames to the same name under one parent: still one wins
  const a = (await admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: "Faisalabad", name: "Rename 1", parent_id: parent })).body.id;
  const b = (await admin(areasHandler, "POST", "/api/admin-shipping-areas", { city: "Faisalabad", name: "Rename 2", parent_id: parent })).body.id;
  const renames = await Promise.all([
    admin(areasHandler, "PATCH", "/api/admin-shipping-areas", { id: a, name: "Renamed" }),
    admin(areasHandler, "PATCH", "/api/admin-shipping-areas", { id: b, name: "Renamed" }),
  ]);
  eq(renames.filter((x) => x.statusCode === 200).length, 1, `statuses ${renames.map((x) => x.statusCode)}`);
  eq(renames.filter((x) => x.statusCode === 409).length, 1);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE parent_id = ? AND name = 'Renamed'", [parent]), 1);

  // riders: unique phone => one wins
  const rr = await Promise.all([
    admin(ridersHandler, "POST", "/api/admin-riders", { name: "Race A", phone: "03111111111" }),
    admin(ridersHandler, "POST", "/api/admin-riders", { name: "Race B", phone: "0311-1111111" }),
  ]);
  eq(rr.filter((x) => x.statusCode === 200).length, 1, `statuses ${rr.map((x) => x.statusCode)}`);
  eq(rr.filter((x) => x.statusCode === 409).length, 1);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM riders WHERE phone = '03111111111'"), 1);
});

/* ------------------------------------------------------------------ L. RBAC + public endpoint */
await section("L new routes: 401 without a session, 403/401 for non-super_admin, public list shape", async () => {
  const editorRaw = crypto.randomBytes(32).toString("hex");
  const editorHash = crypto.createHash("sha256").update(editorRaw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [editorHash, null, 0, "manager", "dops-manager", expires]
  );
  const areas0 = await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas");
  const riders0 = await count(pool, "SELECT COUNT(*) AS c FROM riders");
  const points0 = await count(pool, "SELECT COUNT(*) AS c FROM pickup_points");
  const routes = [
    [areasHandler, "/api/admin-shipping-areas", { city: "Nope", name: "Nope" }],
    [ridersHandler, "/api/admin-riders", { name: "Nope", phone: "03221234567" }],
    [pickupsHandler, "/api/admin-pickup-points", { name: "Nope", city: "Nope", address: "Nope" }],
  ];
  for (const [handler, url, body] of routes) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      clear();
      let res = await invoke(handler, { method, url, body: method === "GET" ? undefined : { ...body, id: 1 }, headers: { origin: "http://orders.test" } });
      eq(res.statusCode, 401, `anonymous ${method} ${url}`);
      clear();
      res = await invoke(handler, { method, url, body: method === "GET" ? undefined : { ...body, id: 1 } });
      ok(res.statusCode === 401 || res.statusCode === 403, `no session, no origin ${method} ${url} => ${res.statusCode}`);
      clear();
      res = await invoke(handler, { method, url, body: method === "GET" ? undefined : { ...body, id: 1 }, ...adminReq(editorRaw) });
      ok(res.statusCode === 401 || res.statusCode === 403, `manager ${method} ${url} => ${res.statusCode}`);
    }
  }
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas"), areas0);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM riders"), riders0);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM pickup_points"), points0);
  // rider assignment is an admin-orders (orders:write) action, still needs a session
  clear();
  const anon = await invoke(adminOrdersHandler, { method: "PATCH", url: "/api/admin-orders", body: { order_id: "X-1", status: "dispatched", rider_id: 1 }, headers: { origin: "http://orders.test" } });
  eq(anon.statusCode, 401);

  // public endpoint: shape + only active rows + no zone / rate data
  await pool.query("INSERT INTO pickup_points (name, city, address, active) VALUES ('Public Point', 'Lahore', 'Somewhere 1', 1), ('Hidden Point', 'Lahore', 'Somewhere 2', 0)");
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1", pickup_enabled: "1" });
  clear();
  let loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations" });
  eq(loc.statusCode, 200, JSON.stringify(loc.body));
  eq(loc.body.areas_enabled, true);
  eq(loc.body.pickup_enabled, true);
  ok(loc.body.areas.length > 0);
  for (const a of loc.body.areas) eq(Object.keys(a), ["id", "city", "name", "parent_id"]);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM shipping_areas WHERE active = 0 AND id IN (?)", [loc.body.areas.map((a) => a.id)]), 0);
  const pubNames = loc.body.pickup_points.map((p) => p.name);
  ok(pubNames.includes("Public Point"), "active Public Point listed");
  ok(!pubNames.includes("Hidden Point"), "inactive Hidden Point hidden");
  for (const p of loc.body.pickup_points) eq(Object.keys(p), ["id", "name", "city", "address", "hours_text", "map_url"]);
  ok(!JSON.stringify(loc.body).includes("zone"), "no zone data");
  clear();
  loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations", query: { city: "x".repeat(101) } });
  eq(loc.statusCode, 400);
  clear();
  loc = await invoke(locationsHandler, { method: "POST", url: "/api/shipping-locations" });
  eq(loc.statusCode, 405);
  await setFlags({ shipping_enabled: null, shipping_areas_enabled: null, pickup_enabled: null });
  clear();
  loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations" });
  eq(loc.body, { areas_enabled: false, pickup_enabled: false });
});

/* ------------------------------------------------------------------ C. parity WITHOUT 0010 */
await section("C flag-OFF parity WITHOUT 0010 (0001..0009 only); flags ON without 0010 => 503", async () => {
  await rebuildFromMigrations(); // does NOT include 0010
  resetCaches();
  for (const t of OPS_TABLES) {
    eq(await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]), 0, `no ${t}`);
  }
  await seedBase();
  const parityC = await parityProbe("without 0010");
  eq(parityC.quoteOffKeys, parityB.quoteOffKeys, "quote keys identical with / without 0010 (flags off)");
  eq(parityC.orderOffKeys, parityB.orderOffKeys, "order keys identical");
  eq(parityC.quoteShipKeys, parityB.quoteShipKeys);
  eq(parityC.orderShipKeys, parityB.orderShipKeys);
  eq(parityC.fingerprintOff, parityB.fingerprintOff, "request fingerprint identical with / without 0010");

  // ready_for_pickup is "Invalid order status" before 0010 (exactly as at ab26978)
  const o = await place([{ id: GOODS, qty: 1 }], { city: "Lahore" });
  const r = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: o.body.order_id, status: "ready_for_pickup" });
  eq(r.statusCode, 400, JSON.stringify(r.body));
  eq(r.body.error, "Invalid order status");

  // enabling a delivery-ops flag without 0010 is refused; forced on => 503, never a partial write
  for (const key of ["shipping_areas_enabled", "pickup_enabled"]) {
    const w = await admin(siteContentHandler, "POST", "/api/site-content", { key, value: "1" });
    eq(w.statusCode, 400, `${key}: ${JSON.stringify(w.body)}`);
  }
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: "1" });
  const orders0 = await count(pool, "SELECT COUNT(*) AS c FROM orders");
  const oo = await place([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { other_area: true } });
  eq(oo.statusCode, 503, JSON.stringify(oo.body));
  eq(oo.body, { error: "Service unavailable" });
  eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), orders0);
  const qq = await quote([{ id: GOODS, qty: 1 }], { city: "Lahore", extra: { other_area: true } });
  eq(qq.statusCode, 503);
  await setFlags({ shipping_enabled: "1", shipping_areas_enabled: null, pickup_enabled: "1" });
  const op = await place([{ id: GOODS, qty: 1 }], { noAddress: true, extra: { fulfilment: "pickup", pickup_point_id: 1 } });
  eq(op.statusCode, 503, JSON.stringify(op.body));
  clear();
  const loc = await invoke(locationsHandler, { method: "GET", url: "/api/shipping-locations" });
  eq(loc.statusCode, 503);
  // the new admin routes answer 503 (not 500) when their tables are missing
  for (const [handler, url] of [[areasHandler, "/api/admin-shipping-areas"], [ridersHandler, "/api/admin-riders"], [pickupsHandler, "/api/admin-pickup-points"]]) {
    const g = await admin(handler, "GET", url);
    eq(g.statusCode, 503, url);
  }
  await allFlagsOff();
});

console.log("DELIVERY_OPS_DB_PASS", JSON.stringify({ sections, assertions: total() }));
await pool.end();
