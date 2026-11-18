/**
 * SANDY-BATCH-12 shipping / courier / RTO — DB/API integration test
 * (REAL pages/api handlers in-process, real MariaDB, schema from migrations/0001..0009 + tax SQL only).
 *
 *   1  flag OFF parity: shipping 0, no new response keys, shipping_amount NULL, no courier/RTO side effects
 *   2  zones/couriers admin API + flag gate (exactly one ACTIVE default zone before shipping_enabled=1)
 *   3  flag ON: tax-quote == order total == stored order for the same basket (zones, free_min, digital, coupon)
 *   4  idempotent replay returns the stored shipping
 *   5  503 { error: 'Service unavailable' } when migration 0009 objects are missing (flag ON)
 *   6  dispatch (courier + tracking, write-once shipped_at), delivered_at, detail, public tracking link
 *   7  RTO: dispatched -> cancelled + rto in ONE transaction (restock, coupon rollback); not for other statuses
 *   8  products.requires_shipping read/write + missing-column tolerance
 *   9  COD risk: refusedCount from RTO orders; byte-identical behaviour on a DB without orders.rto (0001-0008)
 *
 * Env: SANDY_TEST_DB_PASSWORD (required). DB: sandy_mig_orders on 127.0.0.1:3307 (shared; do not run in parallel).
 * Run: node tests/shipping-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  adminReq,
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
const { resetShippingZonesCache } = await importFromRoot("lib/shipping.ts");
const { resetOrderProtectionSettingsCache } = await importFromRoot("lib/orderProtectionSettings.ts");
const { loadCodRiskHistory, resetRtoColumnCache } = await importFromRoot("lib/codRisk.ts");
const { resetCancelReasonColumnCache } = await importFromRoot("lib/orderCancel.ts");

const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const taxQuoteHandler = (await importFromRoot("pages/api/tax-quote.ts")).default;
const eligibilityHandler = (await importFromRoot("pages/api/checkout/eligibility.ts")).default;
const siteContentHandler = (await importFromRoot("pages/api/site-content.ts")).default;
const zonesHandler = (await importFromRoot("pages/api/admin-shipping-zones.ts")).default;
const couriersHandler = (await importFromRoot("pages/api/admin-couriers.ts")).default;
const settingsHandler = (await importFromRoot("pages/api/admin-shipping-settings.ts")).default;
const adminOrdersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const trackHandler = (await importFromRoot("pages/api/track.ts")).default;
const adminProductsHandler = (await importFromRoot("pages/api/admin-products.ts")).default;

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
const token = await mintAdminToken(pool);

function resetCaches() {
  resetShippingSettingsCache();
  resetShippingSchemaCache();
  resetShippingZonesCache();
  resetOrderProtectionSettingsCache();
  resetRtoColumnCache();
  resetCancelReasonColumnCache();
}

async function setFlag(v) {
  await pool.query("DELETE FROM site_content WHERE content_key = 'shipping_enabled'");
  if (v !== null) {
    await pool.query(
      "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES ('shipping_enabled', ?, 'text', 'settings', 'shipping_enabled')",
      [String(v)]
    );
  }
  resetShippingSettingsCache();
}

/** Admin API call through the real handler with a real super_admin session row. */
async function admin(handler, method, url, body, query = {}) {
  clear();
  return invoke(handler, { method, url, body, query, ...adminReq(token) });
}

/* ------------------------------------------------------------------ seed */
await pool.query(
  `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
   VALUES ('Ship Goods', 'ship-goods', 1000, 'Accessories', 'In Stock', 0, NULL, 1),
          ('Legacy Digital', 'legacy-digital', 2000, 'Accessories', 'Digital', 0, NULL, 1),
          ('Service Item', 'service-item', 500, 'Accessories', 'Available', 0, NULL, 1),
          ('Tracked Goods', 'tracked-goods', 1000, 'Accessories', '10', 1, 10, 1)`
);
await pool.query("UPDATE products SET requires_shipping = 0 WHERE slug = 'service-item'");
const idOf = async (slug) => (await one(pool, "SELECT id FROM products WHERE slug = ?", [slug])).id;
const GOODS = await idOf("ship-goods");
const DIGITAL = await idOf("legacy-digital");
const SERVICE = await idOf("service-item");
const TRACKED = await idOf("tracked-goods");
await pool.query("INSERT INTO coupons (code, type, value, minimum_order) VALUES ('TEN','percentage',10,0)");

let seq = 0;
async function place(items, { city = "Lahore", province = "", coupon, phone, key } = {}) {
  clear();
  await sleep(3);
  seq += 1;
  return invoke(ordersHandler, {
    url: "/api/orders",
    body: checkoutBody({
      customer_phone: phone || `0333900${String(seq).padStart(4, "0")}`,
      customer_email: `ship${seq}@example.test`,
      city,
      ...(province ? { province } : {}),
      items,
      payment_method: "cod",
      ...(coupon ? { coupon_code: coupon } : {}),
      ...(key ? { idempotency_key: key } : {}),
    }),
  });
}
async function quote(items, { city = "Lahore", province = "", coupon } = {}) {
  clear();
  return invoke(taxQuoteHandler, {
    url: "/api/tax-quote",
    body: { items, city, ...(province ? { province } : {}), ...(coupon ? { coupon } : {}) },
  });
}
const stored = (orderId) => one(pool, "SELECT * FROM orders WHERE order_id = ?", [orderId]);

/* ------------------------------------------------------------------ 1. flag OFF parity */
await section("1 flag OFF: nothing changes", async () => {
  resetCaches();
  await setFlag(null);
  const q = await quote([{ id: GOODS, qty: 1 }], { city: "Karachi" });
  eq(q.statusCode, 200, JSON.stringify(q.body));
  eq(q.body.shipping, 0);
  ok(!("shipping_zone" in q.body) && !("shipping_estimate" in q.body), "no new tax-quote keys when off");

  const o = await place([{ id: GOODS, qty: 1 }], { city: "Karachi", province: "Sindh" });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  eq(o.body.shipping, 0);
  ok(!("shipping_zone" in o.body), "no shipping_zone key when off");
  eq(Object.keys(o.body), [
    "success", "order_id", "whatsappUrl", "telegramUrl", "subtotal", "shipping", "vat_amount", "tax_label",
    "tax_lines", "discount_amount", "total", "coupon_code", "items",
  ]);
  const row = await stored(o.body.order_id);
  eq(row.shipping_amount, null);
  eq(row.shipping_zone, null);

  await setFlag("0");
  const o2 = await place([{ id: GOODS, qty: 1 }]);
  eq(o2.body.shipping, 0);
  eq((await stored(o2.body.order_id)).shipping_amount, null);

  // admin dispatch with flag off: no shipped_at / courier writes
  const d = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", {
    order_id: o.body.order_id, status: "dispatched", courier_id: 999, tracking_number: "BAD TRACK",
  });
  eq(d.statusCode, 200, JSON.stringify(d.body));
  const after = await stored(o.body.order_id);
  eq(after.status, "dispatched");
  eq(after.shipped_at, null);
  eq(after.tracking_number, null);
});

/* ------------------------------------------------------------------ 2. admin API + flag gate */
let lahoreZoneId = 0;
let defaultZoneId = 0;
await section("2 zones / couriers API + enable gate", async () => {
  resetCaches();
  // cannot enable with no zones
  let r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "1" });
  eq(r.statusCode, 400, JSON.stringify(r.body));
  eq((await one(pool, "SELECT COUNT(*) AS c FROM site_content WHERE content_key = 'shipping_enabled' AND content_value = '1'")).c, 0);
  r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "maybe" });
  eq(r.statusCode, 400);
  r = await admin(siteContentHandler, "PUT", "/api/site-content", { content_key: "shipping_enabled", content_value: "1" });
  eq(r.statusCode, 400, "PUT path is gated too");

  // zone validation
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "", rate: 100 });
  eq(r.statusCode, 400);
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Neg", rate: -1 });
  eq(r.statusCode, 400);
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Neg free", rate: 10, free_min: -5 });
  eq(r.statusCode, 400);
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Rate text", rate: "abc" });
  eq(r.statusCode, 400);

  // inactive default does not count
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Inactive default", is_default: 1, active: 0, rate: 1 });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const inactiveId = r.body.id;
  r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "1" });
  eq(r.statusCode, 400, "inactive default zone is not enough");

  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", {
    name: "Lahore", cities: "Lahore\nKasur", rate: 200, free_min: 5000, estimate_text: "1-2 days", sort_order: 1,
  });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  lahoreZoneId = r.body.id;
  r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "1" });
  eq(r.statusCode, 400, "named zone without a default is not enough");

  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Rest of Pakistan", is_default: 1, rate: 450, free_min: 10000, estimate_text: "3-5 days", sort_order: 9 });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  defaultZoneId = r.body.id;
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Second default", is_default: 1, rate: 1 });
  eq(r.statusCode, 409, "at most one ACTIVE default");
  r = await admin(zonesHandler, "PATCH", "/api/admin-shipping-zones", { id: inactiveId, active: 1 });
  eq(r.statusCode, 409, "re-activating a second default is refused");

  r = await admin(zonesHandler, "GET", "/api/admin-shipping-zones");
  eq(r.statusCode, 200);
  eq(r.body.zones.length, 3);
  eq(r.body.zones.map((z) => z.name), ["Inactive default", "Lahore", "Rest of Pakistan"]);

  // settings readiness
  r = await admin(settingsHandler, "GET", "/api/admin-shipping-settings");
  eq(r.statusCode, 200);
  eq(r.body.shipping_enabled, false);
  eq(r.body.readiness.activeDefaultZones, 1);
  eq(r.body.readiness.ready, true);

  // batch write: rejected shipping_enabled=1 leaves the whole batch unapplied (none here, default exists) -> now allowed
  r = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "1" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq((await one(pool, "SELECT content_value AS v FROM site_content WHERE content_key = 'shipping_enabled'")).v, "1");

  // with the flag on the single active default can not be removed / deactivated / un-defaulted
  for (const [m, body] of [
    ["PATCH", { id: defaultZoneId, active: 0 }],
    ["PATCH", { id: defaultZoneId, is_default: 0 }],
    ["DELETE", { id: defaultZoneId }],
  ]) {
    r = await admin(zonesHandler, m, "/api/admin-shipping-zones", body);
    eq(r.statusCode, 409, `${m} ${JSON.stringify(body)}`);
  }

  // couriers
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "TCS", tracking_url_template: "http://t.example/{tracking}" });
  eq(r.statusCode, 400, "http rejected");
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "TCS", tracking_url_template: "https://t.example/track" });
  eq(r.statusCode, 400, "{tracking} required");
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "TCS", tracking_url_template: "javascript:{tracking}" });
  eq(r.statusCode, 400);
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "", tracking_url_template: "" });
  eq(r.statusCode, 400);
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "TCS", tracking_url_template: "https://t.example/track?cn={tracking}" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  const tcs = r.body.id;
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "Hand delivery", tracking_url_template: "" });
  eq(r.statusCode, 200);
  const hand = r.body.id;
  eq((await one(pool, "SELECT tracking_url_template AS t FROM couriers WHERE id = ?", [hand])).t, null);
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "Dormant" });
  const dormant = r.body.id;
  await pool.query("UPDATE couriers SET active = 0 WHERE id = ?", [dormant]);
  r = await admin(couriersHandler, "PATCH", "/api/admin-couriers", { id: tcs, tracking_url_template: "https://t.example/{tracking}/x" });
  eq(r.statusCode, 200);
  r = await admin(couriersHandler, "PATCH", "/api/admin-couriers", { id: tcs, tracking_url_template: "https://t.example/track?cn={tracking}" });
  eq(r.statusCode, 200);
  r = await admin(couriersHandler, "GET", "/api/admin-couriers");
  eq(r.body.couriers.length, 3);
  globalThis.__couriers = { tcs, hand, dormant };
});

/* ------------------------------------------------------------------ 3. flag ON: surfaces agree */
await section("3 flag ON: quote == order == stored", async () => {
  resetCaches();
  await setFlag("1");

  async function agree(items, opts, expectShipping, expectZone) {
    const q = await quote(items, opts);
    eq(q.statusCode, 200, JSON.stringify(q.body));
    eq(q.body.shipping, expectShipping, `quote shipping ${JSON.stringify(opts)}`);
    eq(q.body.shipping_zone, expectZone);
    const o = await place(items, opts);
    eq(o.statusCode, 200, JSON.stringify(o.body));
    eq(o.body.shipping, expectShipping, "order shipping");
    eq(o.body.total, q.body.total, "order total == quote total");
    eq(o.body.discount_amount, q.body.discount_amount);
    eq(o.body.vat_amount, q.body.vat_amount);
    eq(o.body.shipping_zone, expectZone);
    const row = await stored(o.body.order_id);
    eq(Number(row.shipping_amount), expectShipping);
    eq(row.shipping_zone, expectZone);
    eq(Number(row.total), o.body.total);
    return { q: q.body, o: o.body };
  }

  // city -> Lahore zone, below free_min
  const base = await agree([{ id: GOODS, qty: 1 }], { city: " lahore " }, 200, "Lahore");
  eq(base.q.shipping_estimate, "1-2 days");
  eq(base.o.total, 1000 + 200 + base.o.vat_amount);
  // free exactly at free_min (5 x 1000 = 5000)
  await agree([{ id: GOODS, qty: 5 }], { city: "Lahore" }, 0, "Lahore");
  // coupon pushes the base below free_min: 5000 - 10% = 4500 < 5000 -> pays
  await agree([{ id: GOODS, qty: 5 }], { city: "Lahore", coupon: "TEN" }, 200, "Lahore");
  // province-less unknown city -> default zone (450, free at 10000)
  await agree([{ id: GOODS, qty: 1 }], { city: "Quetta", province: "Balochistan" }, 450, "Rest of Pakistan");
  await agree([{ id: GOODS, qty: 10 }], { city: "Quetta" }, 0, "Rest of Pakistan");
  // legacy digital marker + requires_shipping=0 never ship
  const dig = await agree([{ id: DIGITAL, qty: 1 }], { city: "Lahore" }, 0, null);
  eq(dig.q.shipping_estimate, null);
  await agree([{ id: SERVICE, qty: 3 }], { city: "Karachi" }, 0, null);
  // mixed: digital value does not count toward free_min (3000 shippable < 5000 even though goods total 5000)
  await agree([{ id: GOODS, qty: 3 }, { id: DIGITAL, qty: 1 }], { city: "Lahore" }, 200, "Lahore");
  // inactive zone is ignored: deactivate Lahore -> falls to default
  await pool.query("UPDATE shipping_zones SET active = 0 WHERE id = ?", [lahoreZoneId]);
  resetShippingZonesCache();
  await agree([{ id: GOODS, qty: 1 }], { city: "Lahore" }, 450, "Rest of Pakistan");
  await pool.query("UPDATE shipping_zones SET active = 1 WHERE id = ?", [lahoreZoneId]);
  resetShippingZonesCache();

  // eligibility uses the same compute path (200 when schema is fine)
  clear();
  const el = await invoke(eligibilityHandler, {
    url: "/api/checkout/eligibility",
    body: { phone: "03339991234", email: "elig@example.test", items: [{ id: GOODS, qty: 1 }], city: "Lahore" },
  });
  eq(el.statusCode, 200, JSON.stringify(el.body));

  // invalid province type is rejected (flag on only)
  clear();
  const bad = await invoke(ordersHandler, {
    url: "/api/orders",
    body: checkoutBody({ items: [{ id: GOODS, qty: 1 }], province: { x: 1 } }),
  });
  eq(bad.statusCode, 400);

  // tax: shipping flows into the existing engine (taxable only when rules.shipping_taxable) - total consistent
  const row = await one(pool, "SELECT snapshot_json AS s FROM order_tax_snapshots ORDER BY order_id DESC LIMIT 1");
  const snap = typeof row.s === "string" ? JSON.parse(row.s) : row.s;
  ok(snap.shipping_amount !== undefined, "snapshot records shipping_amount");
});

/* ------------------------------------------------------------------ 4. replay */
await section("4 idempotent replay returns stored shipping", async () => {
  resetCaches();
  await setFlag("1");
  // identical body re-posted (same idempotency key): replay must show the stored shipping, not the new rate
  const body = checkoutBody({
    customer_phone: "03338880002",
    customer_email: "replay@example.test",
    city: "Lahore",
    items: [{ id: GOODS, qty: 1 }],
    payment_method: "cod",
  });
  clear();
  await sleep(3);
  const a = await invoke(ordersHandler, { url: "/api/orders", body });
  eq(a.statusCode, 200, JSON.stringify(a.body));
  await pool.query("UPDATE shipping_zones SET rate = 999 WHERE id = ?", [lahoreZoneId]);
  resetShippingZonesCache();
  clear();
  const b = await invoke(ordersHandler, { url: "/api/orders", body });
  eq(b.statusCode, 200, JSON.stringify(b.body));
  eq(b.body.order_id, a.body.order_id);
  eq(b.body.shipping, 200, "replay reads stored shipping, not the new rate");
  eq(b.body.total, a.body.total);
  eq(b.body.shipping_zone, "Lahore");
  await pool.query("UPDATE shipping_zones SET rate = 200 WHERE id = ?", [lahoreZoneId]);
  resetShippingZonesCache();

  // province participates in the flag-ON fingerprint
  const k2 = crypto.randomUUID();
  const p1 = await place([{ id: GOODS, qty: 1 }], { city: "Quetta", province: "Balochistan", phone: "03338880003", key: k2 });
  eq(p1.statusCode, 200);
});

/* ------------------------------------------------------------------ 5. 503 when 0009 objects are missing */
await section("5 flag ON + missing 0009 objects => 503 Service unavailable", async () => {
  resetCaches();
  await setFlag("1");
  await pool.query("ALTER TABLE orders DROP COLUMN shipping_zone");
  resetShippingSchemaCache();
  const o = await place([{ id: GOODS, qty: 1 }], { city: "Lahore" });
  eq(o.statusCode, 503);
  eq(o.body, { error: "Service unavailable" });
  const q = await quote([{ id: GOODS, qty: 1 }]);
  eq(q.statusCode, 503);
  eq(q.body, { error: "Service unavailable" });
  clear();
  const el = await invoke(eligibilityHandler, {
    url: "/api/checkout/eligibility",
    body: { phone: "03339991235", email: "elig2@example.test", items: [{ id: GOODS, qty: 1 }], city: "Lahore" },
  });
  eq(el.statusCode, 503);
  // enabling is refused while objects are missing
  await setFlag("0");
  const en = await admin(siteContentHandler, "POST", "/api/site-content", { key: "shipping_enabled", value: "1" });
  eq(en.statusCode, 400);
  // flag OFF still works with the column missing (no schema dependency)
  const off = await place([{ id: GOODS, qty: 1 }], { city: "Lahore" });
  eq(off.statusCode, 200, JSON.stringify(off.body));
  eq(off.body.shipping, 0);
  await pool.query("ALTER TABLE orders ADD COLUMN shipping_zone VARCHAR(120) NULL AFTER shipping_amount");
  resetShippingSchemaCache();
  await setFlag("1");
  const back = await place([{ id: GOODS, qty: 1 }], { city: "Lahore" });
  eq(back.statusCode, 200, JSON.stringify(back.body));
});

/* ------------------------------------------------------------------ 6 + 7. dispatch / delivered / track / RTO */
await section("6 dispatch + delivered + detail + public tracking", async () => {
  resetCaches();
  await setFlag("1");
  const { tcs, hand, dormant } = globalThis.__couriers;
  const o = await place([{ id: GOODS, qty: 1 }], { city: "Lahore", phone: "03337770001" });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  const id = o.body.order_id;
  const patch = (body) => admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id, ...body });

  let r = await patch({ status: "dispatched", tracking_number: "ab" });
  eq(r.statusCode, 400, "tracking too short");
  r = await patch({ status: "dispatched", tracking_number: "ABC 123" });
  eq(r.statusCode, 400, "tracking bad chars");
  r = await patch({ status: "dispatched", tracking_number: "A".repeat(101) });
  eq(r.statusCode, 400, "tracking too long");
  r = await patch({ status: "dispatched", courier_id: dormant, tracking_number: "ABC-123" });
  eq(r.statusCode, 400, "inactive courier");
  r = await patch({ status: "dispatched", courier_id: 987654, tracking_number: "ABC-123" });
  eq(r.statusCode, 400, "unknown courier");
  eq((await stored(id)).status, "pending", "invalid dispatch changed nothing");

  r = await patch({ status: "dispatched", courier_id: tcs, tracking_number: "TCS-1234567" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  let row = await stored(id);
  eq(row.status, "dispatched");
  eq(row.courier_id, tcs);
  eq(row.tracking_number, "TCS-1234567");
  ok(row.shipped_at, "shipped_at set");
  const shippedAt = new Date(row.shipped_at).getTime();
  eq(row.delivered_at, null);

  await pool.query("UPDATE orders SET shipped_at = '2020-01-01 10:00:00' WHERE order_id = ?", [id]);
  r = await patch({ status: "dispatched", courier_id: hand, tracking_number: "HAND-9" });
  eq(r.statusCode, 200);
  row = await stored(id);
  eq(new Date(row.shipped_at).getFullYear(), 2020, "shipped_at never overwritten");
  eq(row.courier_id, hand);
  eq(row.tracking_number, "HAND-9");
  ok(shippedAt > 0);
  r = await patch({ status: "dispatched", courier_id: tcs, tracking_number: "TCS-1234567" });
  eq(r.statusCode, 200);

  // detail
  r = await admin(adminOrdersHandler, "GET", "/api/admin-orders", undefined, { id });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(r.body.order.courier_name, "TCS");
  eq(r.body.order.tracking_number, "TCS-1234567");
  eq(r.body.order.tracking_url, "https://t.example/track?cn=TCS-1234567");
  eq(Number(r.body.order.shipping_amount), 200);
  eq(r.body.order.shipping_zone, "Lahore");
  eq(r.body.order.rto, null);
  ok(r.body.order.couriers.some((c) => c.name === "TCS") && !r.body.order.couriers.some((c) => c.name === "Dormant"));

  // public tracking
  clear();
  const email = (await stored(id)).customer_email;
  const t = await invoke(trackHandler, { url: "/api/track", body: { order_id: id, email } });
  eq(t.statusCode, 200, JSON.stringify(t.body));
  eq(t.body.order.courier_name, "TCS");
  eq(t.body.order.tracking_number, "TCS-1234567");
  eq(t.body.order.tracking_url, "https://t.example/track?cn=TCS-1234567");

  // http template stored out-of-band is never emitted
  await pool.query("UPDATE couriers SET tracking_url_template = 'http://t.example/{tracking}' WHERE id = ?", [tcs]);
  clear();
  const t2 = await invoke(trackHandler, { url: "/api/track", body: { order_id: id, email } });
  ok(!("tracking_url" in t2.body.order), "http link omitted");
  await pool.query("UPDATE couriers SET tracking_url_template = 'https://t.example/track?cn={tracking}' WHERE id = ?", [tcs]);

  // delivered_at write-once
  r = await patch({ status: "delivered" });
  eq(r.statusCode, 200);
  row = await stored(id);
  ok(row.delivered_at, "delivered_at set");
  await pool.query("UPDATE orders SET delivered_at = '2021-02-03 04:05:06' WHERE order_id = ?", [id]);
  r = await patch({ status: "delivered" });
  eq(r.statusCode, 200);
  eq(new Date((await stored(id)).delivered_at).getFullYear(), 2021, "delivered_at never overwritten");

  // an order that never got a courier: tracking payload has no courier keys
  const o2 = await place([{ id: GOODS, qty: 1 }], { city: "Lahore", phone: "03337770002" });
  clear();
  const t3 = await invoke(trackHandler, { url: "/api/track", body: { order_id: o2.body.order_id, email: (await stored(o2.body.order_id)).customer_email } });
  eq(t3.statusCode, 200);
  ok(!("courier_name" in t3.body.order) && !("tracking_number" in t3.body.order) && !("tracking_url" in t3.body.order));
});

await section("7 RTO: one transaction, dispatched only", async () => {
  resetCaches();
  await setFlag("1");
  const phone = "03337770009";
  const phoneNorm = "03337770009";
  const o = await place([{ id: TRACKED, qty: 2 }], { city: "Lahore", phone, coupon: "TEN" });
  eq(o.statusCode, 200, JSON.stringify(o.body));
  const id = o.body.order_id;
  eq(Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q), 8);
  eq(Number((await one(pool, "SELECT used_count AS u FROM coupons WHERE code = 'TEN'")).u) > 0, true);
  const usedBefore = Number((await one(pool, "SELECT used_count AS u FROM coupons WHERE code = 'TEN'")).u);
  await pool.query("UPDATE orders SET customer_phone_norm = ? WHERE order_id = ?", [phoneNorm, id]);
  const rto = () => admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id, action: "rto" });

  let r = await rto();
  eq(r.statusCode, 409, "pending order cannot be RTO");
  eq((await stored(id)).status, "pending");
  eq((await stored(id)).rto, null);

  await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id, status: "dispatched" });
  r = await rto();
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(r.body.rto, true);
  const row = await stored(id);
  eq(row.status, "cancelled");
  eq(row.cancel_reason, "Returned to origin (RTO)");
  eq(Number(row.rto), 1);
  ok(row.rto_at, "rto_at set");
  eq(Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q), 10, "stock restored");
  eq(Number((await one(pool, "SELECT used_count AS u FROM coupons WHERE code = 'TEN'")).u), usedBefore - 1, "coupon rolled back");

  r = await rto();
  eq(r.statusCode, 409, "cannot RTO twice");
  eq(Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q), 10, "no double restock");
  r = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: "NOPE-1", action: "rto" });
  eq(r.statusCode, 404);

  // detail shows the RTO flag
  r = await admin(adminOrdersHandler, "GET", "/api/admin-orders", undefined, { id });
  eq(r.body.order.rto, true);
  ok(r.body.order.rto_at);

  // atomicity: if the rto UPDATE fails, nothing else is committed (simulate by removing rto_at)
  const o2 = await place([{ id: TRACKED, qty: 1 }], { city: "Lahore", phone: "03337770010" });
  const id2 = o2.body.order_id;
  await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id2, status: "dispatched" });
  const stockBefore = Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q);
  // The positive schema probe is cached, so the RTO path starts the cancel transaction and the final
  // rto UPDATE fails (rto_at missing): the whole transaction must roll back.
  await pool.query("ALTER TABLE orders DROP COLUMN rto_at");
  r = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id2, action: "rto" });
  eq(r.statusCode, 500, JSON.stringify(r.body));
  eq((await stored(id2)).status, "dispatched", "status untouched");
  eq(Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [TRACKED])).q), stockBefore, "stock untouched");
  await pool.query("ALTER TABLE orders ADD COLUMN rto_at DATETIME NULL");
  resetShippingSchemaCache();
  r = await admin(adminOrdersHandler, "PATCH", "/api/admin-orders", { order_id: id2, action: "rto" });
  eq(r.statusCode, 200, JSON.stringify(r.body));

  // COD risk now sees the RTO history (separate query), counts from the primary SELECT preserved
  resetRtoColumnCache();
  const hist = await loadCodRiskHistory(pool, phoneNorm);
  eq(hist.refusedCount, 1, "one RTO order for the phone (the second order has another phone norm)");
  eq(hist.cancelledCount, 1);
});

/* ------------------------------------------------------------------ 8. products.requires_shipping */
await section("8 admin-products requires_shipping", async () => {
  resetCaches();
  const product = (over = {}) => ({
    name: "RS Product", slug: `rs-${crypto.randomUUID().slice(0, 8)}`, price: 100, category: "Accessories",
    track_inventory: 0, ...over,
  });
  await pool.query("INSERT IGNORE INTO categories (name, slug, active) VALUES ('Accessories','accessories',1)");
  let r = await admin(adminProductsHandler, "POST", "/api/admin-products", product({ requires_shipping: 0 }));
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(Number((await one(pool, "SELECT requires_shipping AS v FROM products WHERE id = ?", [r.body.id])).v), 0);
  const pid = r.body.id;
  r = await admin(adminProductsHandler, "PUT", "/api/admin-products", { ...product({ requires_shipping: 1 }), id: pid, slug: "rs-updated" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(Number((await one(pool, "SELECT requires_shipping AS v FROM products WHERE id = ?", [pid])).v), 1);
  r = await admin(adminProductsHandler, "GET", "/api/admin-products");
  ok(r.body.find((p) => p.id === pid) && "requires_shipping" in r.body.find((p) => p.id === pid), "GET exposes the column");
  r = await admin(adminProductsHandler, "POST", "/api/admin-products", product({ requires_shipping: "nope" }));
  eq(r.statusCode, 400);
  r = await admin(adminProductsHandler, "POST", "/api/admin-products", product());
  eq(r.statusCode, 200);
  eq(Number((await one(pool, "SELECT requires_shipping AS v FROM products WHERE id = ?", [r.body.id])).v), 1, "default 1");

  // column missing (pre-0009): saving must not fail
  await pool.query("ALTER TABLE products DROP COLUMN requires_shipping");
  resetShippingSchemaCache();
  r = await admin(adminProductsHandler, "POST", "/api/admin-products", product({ requires_shipping: 0 }));
  eq(r.statusCode, 200, JSON.stringify(r.body));
  r = await admin(adminProductsHandler, "PUT", "/api/admin-products", { ...product({ requires_shipping: 0 }), id: pid, slug: "rs-updated" });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  await pool.query("ALTER TABLE products ADD COLUMN requires_shipping TINYINT(1) NOT NULL DEFAULT 1");
  resetShippingSchemaCache();
});

/* ------------------------------------------------------------------ 9. delete soft-deactivate */
await section("9 DELETE zone / courier in use => soft deactivate", async () => {
  resetCaches();
  await setFlag("0");
  const { tcs } = globalThis.__couriers;
  let r = await admin(couriersHandler, "DELETE", "/api/admin-couriers", { id: tcs });
  eq(r.statusCode, 200);
  eq(r.body.deactivated, true);
  eq(Number((await one(pool, "SELECT active AS a FROM couriers WHERE id = ?", [tcs])).a), 0);
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", { name: "Unused" });
  const unused = r.body.id;
  r = await admin(couriersHandler, "DELETE", "/api/admin-couriers", { id: unused });
  eq(r.body.deleted, true);
  eq(await count(pool, "SELECT COUNT(*) AS c FROM couriers WHERE id = ?", [unused]), 0);

  r = await admin(zonesHandler, "DELETE", "/api/admin-shipping-zones", { id: lahoreZoneId });
  eq(r.statusCode, 200);
  eq(r.body.deactivated, true, "Lahore zone is referenced by orders");
  eq(Number((await one(pool, "SELECT active AS a FROM shipping_zones WHERE id = ?", [lahoreZoneId])).a), 0);
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", { name: "Throwaway", rate: 5 });
  r = await admin(zonesHandler, "DELETE", "/api/admin-shipping-zones", { id: r.body.id });
  eq(r.body.deleted, true);
  r = await admin(zonesHandler, "DELETE", "/api/admin-shipping-zones", { id: 987654 });
  eq(r.statusCode, 404);
});

/* ------------------------------------------------------------------ 10. COD risk on a 0001-0008 database */
await section("10 loadCodRiskHistory on a database without orders.rto (0001-0008)", async () => {
  resetCaches();
  const norm = "03336660001";
  for (const [i, status] of ["delivered", "delivered", "cancelled", "pending"].entries()) {
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, postcode,
                           payment_method, total, status, customer_phone_norm)
       VALUES (?, 'H', 'h@example.test', ?, 'x', 'x', 'x', 'cod', 100, ?, ?)`,
      [`HIST-${i}`, norm, status, norm]
    );
  }
  await pool.query("UPDATE orders SET rto = 1 WHERE order_id = 'HIST-2'");
  resetRtoColumnCache();
  const withCol = await loadCodRiskHistory(pool, norm);
  eq(withCol, { deliveredCount: 2, cancelledCount: 1, refusedCount: 1, openCodPendingCount: 1 });

  await pool.query("ALTER TABLE orders DROP INDEX idx_orders_rto_phone");
  await pool.query("ALTER TABLE orders DROP COLUMN rto");
  resetRtoColumnCache();
  const without = await loadCodRiskHistory(pool, norm);
  eq(without, { deliveredCount: 2, cancelledCount: 1, refusedCount: 0, openCodPendingCount: 1 }, "same counts as before 0009; refused stays 0");
});

console.log(
  "SHIPPING_DB_PASS",
  JSON.stringify({ sections, assertions: total() })
);
await pool.end();
