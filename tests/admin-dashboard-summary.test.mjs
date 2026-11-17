/**
 * Local MariaDB + source/auth-shape + pure-helper tests for ADMIN-DASH-01 / ADMIN-DASH-02.
 * Host 127.0.0.1:3307 / sandy_test_local. No production.
 *
 * Layout
 *  1. Pure helpers from lib/dashboardExtras.ts — imported for real (a temp copy with the
 *     extensionless "./orderCancel" import rewritten, run through node's type stripping).
 *  2. Legacy DASH-* seed (ADMIN-DASH-01 aggregates, unchanged assertions).
 *  3. DASH2-* seed (150 orders). Every SQL aggregate used by the endpoint is mirrored below
 *     (scoped to the DASH2-% prefix) and compared with expectations that are computed from the
 *     seed specs in JS, plus hand-computed literals for the hand-written blocks.
 *  4. Source-shape checks for the endpoint / site-content route.
 *
 * Env: SANDY_TEST_DB_PASSWORD
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
  charset: "utf8mb4",
  multipleStatements: true,
});

// ---------------------------------------------------------------------------------------------
// Counted assertions
// ---------------------------------------------------------------------------------------------
let asserts = 0;
const eq = (actual, expected, msg) => {
  assert.deepStrictEqual(actual, expected, msg);
  asserts++;
};
const ok = (v, msg) => {
  assert.ok(v, msg);
  asserts++;
};
const match = (s, re, msg) => {
  assert.match(s, re, msg);
  asserts++;
};
const noMatch = (s, re, msg) => {
  assert.doesNotMatch(s, re, msg);
  asserts++;
};
/** DECIMAL string / float -> integer cents. */
const cents = (v) => Math.round(Number(v) * 100);

// ---------------------------------------------------------------------------------------------
// 1. Real lib/dashboardExtras.ts via temp copy (node type stripping; "./orderCancel" needs .ts)
// ---------------------------------------------------------------------------------------------
async function loadLib() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dash2-lib-"));
  const extras = await fs.readFile(path.join(root, "lib/dashboardExtras.ts"), "utf8");
  const cancel = await fs.readFile(path.join(root, "lib/orderCancel.ts"), "utf8");
  match(extras, /from "\.\/orderCancel"/, "dashboardExtras import shape changed; update loader");
  await fs.writeFile(path.join(dir, "dashboardExtras.ts"), extras.replace('from "./orderCancel"', 'from "./orderCancel.ts"'));
  await fs.writeFile(path.join(dir, "orderCancel.ts"), cancel);
  const mod = await import(pathToFileURL(path.join(dir, "dashboardExtras.ts")).href);
  const cancelMod = await import(pathToFileURL(path.join(dir, "orderCancel.ts")).href);
  return { lib: mod, cancelMod, dir };
}

function pureHelperTests(lib, cancelMod) {
  const {
    parseLowStockThreshold,
    resolveLowStockThreshold,
    parseOrderItemsJson,
    bucketCancelReason,
    formatPendingAge,
    aggregateTopProducts,
    capTrendPoints,
    LOW_STOCK_CONTENT_KEY,
    LOW_STOCK_DEFAULT,
    LOW_STOCK_MAX,
    TREND_MAX_POINTS,
  } = lib;

  eq(LOW_STOCK_CONTENT_KEY, "admin_low_stock_threshold");
  eq(LOW_STOCK_DEFAULT, 5);
  eq(LOW_STOCK_MAX, 9999);
  eq(TREND_MAX_POINTS, 90);

  // parseLowStockThreshold — valid
  for (const [raw, value] of [
    [0, 0],
    ["0", 0],
    [5, 5],
    ["5", 5],
    [" 12 ", 12],
    ["9999", 9999],
    [9999, 9999],
    ["007", 7],
  ]) {
    eq(parseLowStockThreshold(raw), { ok: true, value }, `valid ${JSON.stringify(raw)}`);
  }
  // parseLowStockThreshold — invalid
  for (const raw of [
    "",
    "   ",
    null,
    undefined,
    "-1",
    -1,
    "1.5",
    1.5,
    "10000",
    10000,
    "abc",
    "5abc",
    "1e2",
    "0x10",
    "+5",
    "٣", // arabic-indic digit
    NaN,
    Infinity,
    true,
    {},
  ]) {
    eq(parseLowStockThreshold(raw), { ok: false, error: "Invalid low stock threshold" }, `invalid ${String(raw)}`);
  }

  // resolveLowStockThreshold (reads never throw; fall back to default)
  for (const [raw, want] of [
    [null, 5],
    [undefined, 5],
    ["", 5],
    ["  ", 5],
    ["abc", 5],
    ["10000", 5],
    ["-3", 5],
    ["1.5", 5],
    ["0", 0],
    ["7", 7],
    [" 9 ", 9],
    ["9999", 9999],
  ]) {
    eq(resolveLowStockThreshold(raw), want, `resolve ${JSON.stringify(raw)}`);
  }

  // bucketCancelReason — presets come from orderCancel, hard-coded here so a rename is caught.
  const presetLabels = [
    "Customer cancelled the order",
    "Wrong or unreachable address",
    "Payment not received",
    "Duplicate order",
    "Out of stock",
  ];
  eq(
    cancelMod.CANCEL_PRESETS.filter((p) => p.code !== "other").map((p) => p.label),
    presetLabels
  );
  for (const l of presetLabels) {
    eq(bucketCancelReason(l), l);
    eq(bucketCancelReason(`  ${l}  `), l, "padded preset");
  }
  for (const other of [
    "Other",
    "out of stock", // case-sensitive exact match
    "Out of stock!",
    "Customer asked to cancel via WhatsApp",
    "گاہک نے منسوخ کیا",
    "",
    "   ",
    null,
    undefined,
    123,
    {},
  ]) {
    eq(bucketCancelReason(other), "Other", `other ${String(other)}`);
  }

  // parseOrderItemsJson
  eq(parseOrderItemsJson(""), []);
  eq(parseOrderItemsJson("   "), []);
  eq(parseOrderItemsJson(null), []);
  eq(parseOrderItemsJson(undefined), []);
  eq(parseOrderItemsJson("[]"), []);
  eq(parseOrderItemsJson("null"), []);
  eq(parseOrderItemsJson([]), []);
  eq(parseOrderItemsJson('{"name": broken'), null);
  eq(parseOrderItemsJson("not json"), null);
  eq(parseOrderItemsJson('"str"'), null);
  eq(parseOrderItemsJson("42"), null);
  eq(parseOrderItemsJson('{"name":"X"}'), null, "object, not array");
  eq(parseOrderItemsJson('[{"qty":1,"price":5}]'), null, "missing name");
  eq(parseOrderItemsJson('[{"name":"  ","qty":1,"price":5}]'), null, "blank name");
  eq(parseOrderItemsJson('[{"name":"X","qty":-1,"price":1}]'), null, "negative qty");
  eq(parseOrderItemsJson('[{"name":"X","qty":"abc","price":1}]'), null, "NaN qty");
  eq(parseOrderItemsJson('[{"name":"X","qty":1,"price":"abc"}]'), null, "NaN price");
  eq(parseOrderItemsJson('[1,2]'), null, "non-object rows");
  eq(parseOrderItemsJson('[null]'), null, "null row");
  eq(parseOrderItemsJson('[[1]]'), null, "array row");
  eq(parseOrderItemsJson('[{"name":"A","qty":1,"price":1},{"qty":1}]'), null, "one bad row poisons the order");
  eq(parseOrderItemsJson('[{"name":"A","qty":2,"price":3.5,"product_id":7}]'), [
    { product_id: 7, name: "A", units: 2, revenue: 7 },
  ]);
  eq(parseOrderItemsJson('[{"product_name":"  B  ","quantity":"3","unit_price":"10.5","product_id":null}]'), [
    { product_id: null, name: "B", units: 3, revenue: 31.5 },
  ]);
  eq(parseOrderItemsJson('[{"name":"C","qty":1,"price":1,"product_id":"12"}]')[0].product_id, 12, "string pid coerced");
  eq(parseOrderItemsJson('[{"name":"C","qty":1,"price":1,"product_id":"zz"}]')[0].product_id, null, "bad pid -> null");
  eq(parseOrderItemsJson('[{"name":"چائے ☕ 🧃","qty":4,"price":250}]'), [
    { product_id: null, name: "چائے ☕ 🧃", units: 4, revenue: 1000 },
  ]);
  eq(parseOrderItemsJson('[{"name":"Free","qty":0,"price":0}]'), [{ product_id: null, name: "Free", units: 0, revenue: 0 }]);
  // already-parsed JS value (mysql2 may hand back parsed JSON columns)
  eq(parseOrderItemsJson([{ name: "P", qty: 1, price: 2 }]), [{ product_id: null, name: "P", units: 1, revenue: 2 }]);
  eq(parseOrderItemsJson({ name: "P" }), null);

  // formatPendingAge
  const now = new Date("2026-11-17T12:00:00Z");
  const ago = (h, extraMs = 0) => new Date(now.getTime() - h * 3600000 - extraMs);
  eq(formatPendingAge(ago(0), now), { age_hours: 0, age_label: "0h" });
  eq(formatPendingAge(new Date(now.getTime() + 5000), now), { age_hours: 0, age_label: "0h" }, "future clamps to 0");
  eq(formatPendingAge(ago(1, 59 * 60000), now), { age_hours: 1, age_label: "1h" }, "floor");
  eq(formatPendingAge(ago(47, 3599000), now), { age_hours: 47, age_label: "47h" });
  eq(formatPendingAge(ago(48), now), { age_hours: 48, age_label: "2d" });
  eq(formatPendingAge(ago(71), now), { age_hours: 71, age_label: "2d" });
  eq(formatPendingAge(ago(100), now), { age_hours: 100, age_label: "4d" });

  // aggregateTopProducts: merge, id/name keying, limit 5, tie-breaks
  const L = (pid, name, units, revenue) => ({ product_id: pid, name, units, revenue });
  const top = aggregateTopProducts([
    L(1, "A", 2, 20),
    L(1, "A", 3, 30), // merges -> 5 / 50
    L(2, "A", 1, 999), // same name, different id -> separate row
    L(null, "N", 5, 10), // ties A on units; lower revenue
    L(3, "C", 4, 400),
    L(4, "D", 4, 400), // ties C fully -> name asc
    L(5, "E", 1, 1),
    L(6, "F", 1, 2),
    L(7, "G", 1, 3),
  ]);
  eq(
    top.by_units.map((r) => `${r.product_id}:${r.name}:${r.units}:${r.revenue}`),
    ["1:A:5:50", "null:N:5:10", "3:C:4:400", "4:D:4:400", "2:A:1:999"],
    "by_units order (units desc, revenue desc, name asc, max 5)"
  );
  eq(
    top.by_revenue.map((r) => r.name + ":" + r.revenue),
    ["A:999", "C:400", "D:400", "A:50", "N:10"],
    "by_revenue order"
  );
  eq(aggregateTopProducts([]), { by_units: [], by_revenue: [] });
  eq(aggregateTopProducts(Array.from({ length: 9 }, (_, i) => L(i, `P${i}`, i + 1, 1))).by_units.length, 5);

  // capTrendPoints
  const pts = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `k${i}`, incl: i, excl: i }));
  eq(capTrendPoints(pts(0)), []);
  eq(capTrendPoints(pts(90)).length, 90);
  const capped = capTrendPoints(pts(91));
  eq(capped.length, 90);
  eq(capped[0].key, "k1", "drops the oldest bucket");
  eq(capped[89].key, "k90");
  eq(capTrendPoints(pts(200))[0].key, "k110");
}

// ---------------------------------------------------------------------------------------------
// 2. Schema
// ---------------------------------------------------------------------------------------------
async function recreateSchema() {
  // Local test DB only — replace the stub orders table from earlier runs.
  await pool.query("DROP TABLE IF EXISTS orders");
  await pool.query(`
    CREATE TABLE orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(64) UNIQUE NOT NULL,
      customer_name VARCHAR(255) NULL,
      customer_email VARCHAR(255) NULL,
      customer_phone VARCHAR(64) NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      vat_amount DECIMAL(12,2) NULL,
      discount_amount DECIMAL(12,2) NULL,
      coupon_code VARCHAR(50) NULL,
      status VARCHAR(32) NOT NULL,
      payment_method VARCHAR(32) NULL,
      cancel_reason VARCHAR(500) NULL,
      items TEXT NULL,
      receipt_path VARCHAR(500) NULL,
      payment_reference VARCHAR(255) NULL,
      created_at DATETIME NOT NULL
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      price DECIMAL(10,2),
      quantity INT DEFAULT 1
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      active TINYINT NULL DEFAULT 1,
      track_inventory TINYINT(1) NOT NULL DEFAULT 1,
      stock_quantity INT NULL,
      UNIQUE KEY unique_slug (slug)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Older stubs may lack columns.
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS slug VARCHAR(255) NULL");
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS active TINYINT NULL DEFAULT 1");
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory TINYINT(1) NOT NULL DEFAULT 1");
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INT NULL");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_content (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content_key VARCHAR(100) UNIQUE NOT NULL,
      content_value TEXT,
      content_type ENUM('text','textarea','image','url') DEFAULT 'text',
      page_name VARCHAR(50),
      label VARCHAR(100),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ---------------------------------------------------------------------------------------------
// 3a. Legacy DASH-* seed (ADMIN-DASH-01) — unchanged expectations
// ---------------------------------------------------------------------------------------------
async function seedLegacy() {
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'DASH-%'");
  await pool.query("DELETE FROM products WHERE name LIKE 'DASH-%'");
  const rows = [
    // pending on D0: total 1000 vat 180
    ["DASH-P1", "A", "a@ex.com", "pending", 1000, 180, "2026-11-10 00:30:00"],
    ["DASH-C1", "B", "b@ex.com", "confirmed", 500, 50, "2026-11-10 12:00:00"],
    ["DASH-X1", "A", "a@ex.com", "dispatched", 200, 20, "2026-11-10 15:00:00"],
    ["DASH-D1", "C", "c@ex.com", "delivered", 800, 80, "2026-11-10 18:00:00"],
    ["DASH-Z1", "D", "d@ex.com", "cancelled", 300, 30, "2026-11-10 20:00:00"],
    ["DASH-N1", "E", "e@ex.com", "pending", 1178.82, null, "2026-11-10 21:00:00"],
    ["DASH-OLD", "F", "f@ex.com", "delivered", 999, 99, "2026-11-09 18:59:00"],
    ["DASH-NEW", "G", "g@ex.com", "delivered", 400, 40, "2026-11-11 00:30:00"],
  ];
  for (const [id, name, email, status, total, vat, created] of rows) {
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, total, vat_amount, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, name, email, "0300", total, vat, status, created]
    );
  }
  await pool.query(
    "INSERT INTO products (name, slug, active) VALUES ('DASH-Active','dash-active',1),('DASH-Null','dash-null',NULL),('DASH-Off','dash-off',0)"
  );
}

async function legacyAssertions() {
  const [hand] = await pool.query(
    `SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_orders,
      COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END),0) AS delivered_orders,
      COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN 1 ELSE 0 END),0) AS confirmed_sales_count,
      COALESCE(SUM(CASE WHEN status='pending' THEN total ELSE 0 END),0) AS pending_incl,
      COALESCE(SUM(CASE WHEN status='pending' THEN total - COALESCE(vat_amount,0) ELSE 0 END),0) AS pending_excl,
      COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN total ELSE 0 END),0) AS confirmed_incl,
      COALESCE(SUM(CASE WHEN status='delivered' THEN total ELSE 0 END),0) AS revenue_incl,
      COALESCE(SUM(CASE WHEN status='cancelled' THEN total ELSE 0 END),0) AS cancelled_incl,
      COALESCE(SUM(CASE WHEN vat_amount IS NULL THEN 1 ELSE 0 END),0) AS vat_null_orders
     FROM orders WHERE order_id LIKE 'DASH-%'`
  );
  const h = hand[0];
  eq(Number(h.total_orders), 8);
  eq(Number(h.pending_orders), 2);
  eq(Number(h.delivered_orders), 3);
  eq(Number(h.cancelled_orders), 1);
  eq(Number(h.confirmed_sales_count), 5);
  eq(Number(h.revenue_incl), 2199);
  eq(Number(h.cancelled_incl), 300);
  eq(Number(h.vat_null_orders), 1);
  eq(Number(h.confirmed_incl), 500 + 200 + 800 + 999 + 400);
  eq(cents(h.pending_incl), 217882);
  // NULL vat treated as 0 for excl
  eq(cents(h.pending_excl), cents(1000 - 180 + 1178.82));

  const fromSql = "2026-11-10 00:00:00";
  const toEx = "2026-11-11 00:00:00";
  const [dayRows] = await pool.query(
    `SELECT COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN status='delivered' THEN total ELSE 0 END),0) AS rev
     FROM orders WHERE order_id LIKE 'DASH-%' AND created_at >= ? AND created_at < ?`,
    [fromSql, toEx]
  );
  eq(Number(dayRows[0].c), 6);
  eq(Number(dayRows[0].rev), 800);

  const [empty] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders WHERE order_id LIKE 'DASH-%' AND created_at >= ? AND created_at < ?`,
    ["2099-01-01 00:00:00", "2099-01-02 00:00:00"]
  );
  eq(Number(empty[0].c), 0);

  const [prods] = await pool.query(
    `SELECT COUNT(*) AS c FROM products WHERE name LIKE 'DASH-%' AND (active = 1 OR active IS NULL)`
  );
  eq(Number(prods[0].c), 2);

  const [cust] = await pool.query(
    `SELECT COUNT(*) AS c FROM (
      SELECT customer_email FROM orders WHERE order_id LIKE 'DASH-%' AND customer_email IS NOT NULL AND customer_email != ''
      GROUP BY customer_email
    ) t`
  );
  eq(Number(cust[0].c), 7);
  return { dayRev: Number(dayRows[0].rev), products: Number(prods[0].c), customers: Number(cust[0].c) };
}

// ---------------------------------------------------------------------------------------------
// 3b. DASH2-* seed specs
// ---------------------------------------------------------------------------------------------
const PREFIX = "DASH2-";
const PRESET_LABELS = [
  "Customer cancelled the order",
  "Wrong or unreachable address",
  "Payment not received",
  "Duplicate order",
  "Out of stock",
];
const CONFIRMED = new Set(["confirmed", "dispatched", "delivered"]);

const pad2 = (n) => String(n).padStart(2, "0");
const utcStr = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const parseUtc = (s) => Date.parse(s.replace(" ", "T") + "Z");
const pktKey = (utc, len) => new Date(parseUtc(utc) + 5 * 3600000).toISOString().slice(0, len);

/** PKT calendar range [from, to] inclusive -> [fromUtcSql, toExclusiveUtcSql]. Mirrors endpoint. */
function pktRange(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return [utcStr(Date.UTC(fy, fm - 1, fd) - 5 * 3600000), utcStr(Date.UTC(ty, tm - 1, td + 1) - 5 * 3600000)];
}

/**
 * Order spec:
 *  id, status, total (cents), vat (cents|null), pm, coupon, disc (cents|null), cancel, items,
 *  created (UTC DATETIME string), email, rows (order_items rows), lines (expected top-product
 *  lines — only meaningful for delivered orders).
 */
function mk(id, status, totalC, o = {}) {
  return {
    id: PREFIX + id,
    status,
    total: totalC,
    vat: o.vat === undefined ? 0 : o.vat,
    pm: o.pm === undefined ? "cod" : o.pm,
    coupon: o.coupon ?? null,
    disc: o.disc ?? null,
    cancel: o.cancel ?? null,
    items: o.items === undefined ? null : o.items,
    created: o.created,
    email: o.email ?? null,
    rows: o.rows || [],
    lines: o.lines || [],
  };
}
const IR = (pid, name, priceC, qty) => ({ pid, name, price: priceC, qty });
const EL = (pid, name, units, revC) => ({ pid, name, units, rev: revC });

function buildSeed() {
  const specs = [];

  // --- W: window block 2026-11-05..2026-11-07 PKT (= [2026-11-04 19:00, 2026-11-07 19:00) UTC) ---
  specs.push(
    mk("T1", "delivered", 10000, {
      vat: 1000, pm: "cod", created: "2026-11-04 18:59:59", // PKT 11-04 23:59:59 -> just OUTSIDE window
      rows: [IR(505, "DASH2 Edge A", 10000, 1)],
      lines: [EL(505, "DASH2 Edge A", 1, 10000)],
    }),
    mk("T2", "delivered", 20000, {
      vat: 2000, pm: "cod", coupon: "WINTER", disc: 2000, created: "2026-11-04 19:00:00", email: "w1@dash2.test", // PKT 11-05 00:00:00 -> first instant IN
      rows: [IR(501, "DASH2 Edge B", 10000, 2)],
      lines: [EL(501, "DASH2 Edge B", 2, 20000)],
    }),
    mk("T3", "delivered", 30000, {
      vat: null, pm: "jazzcash", created: "2026-11-05 18:59:59", email: "w2@dash2.test", // PKT 11-05 23:59:59, legacy NULL vat
      items: JSON.stringify([{ name: "DASH2 Edge B", qty: 1, price: 300, product_id: 501 }]),
      lines: [EL(501, "DASH2 Edge B", 1, 30000)],
    }),
    mk("T4", "delivered", 40000, {
      vat: 4000, pm: null, coupon: "winter", disc: null, created: "2026-11-05 19:00:00", email: "w1@dash2.test", // PKT 11-06 00:00:00
      rows: [IR(502, "DASH2 Édge ✓ 日本", 40000, 1)],
      lines: [EL(502, "DASH2 Édge ✓ 日本", 1, 40000)],
    }),
    mk("T5", "delivered", 5000, {
      vat: 500, pm: "easypaisa", created: "2026-11-06 12:00:00", email: null,
      rows: [IR(503, "DASH2 Edge D", 5000, 1)],
      lines: [EL(503, "DASH2 Edge D", 1, 5000)],
    }),
    mk("T6", "delivered", 7000, {
      vat: 700, pm: "cod", created: "2026-11-07 18:59:59", email: "", // PKT 11-07 23:59:59 -> last instant IN
      rows: [IR(504, "DASH2 Edge E", 3500, 2)],
      lines: [EL(504, "DASH2 Edge E", 2, 7000)],
    }),
    mk("T7", "delivered", 8000, {
      vat: 800, pm: "cod", created: "2026-11-07 19:00:00", // PKT 11-08 00:00:00 -> OUTSIDE
      rows: [IR(506, "DASH2 Edge C", 8000, 1)],
      lines: [EL(506, "DASH2 Edge C", 1, 8000)],
    }),
    // noise inside the window: pending (counts for payments/pending, never revenue/top products)
    mk("WP", "pending", 999900, {
      vat: 0, pm: "cod", created: "2026-11-06 00:00:00", email: "w3@dash2.test",
      rows: [IR(900, "DASH2 Ghost", 100000, 500)],
    }),
    // cancelled with preset reason, NULL vat, coupon (coupon_usage ignores status)
    mk("WC", "cancelled", 888800, {
      vat: null, pm: "jazzcash", coupon: "SAVE10", disc: 5000, cancel: "Out of stock", created: "2026-11-06 01:00:00", email: "w3@dash2.test",
    })
  );

  // --- M: month boundary (PKT) ---
  specs.push(
    mk("M1", "delivered", 100000, { vat: 10000, created: "2026-10-31 18:59:59" }), // PKT 2026-10-31 23:59:59
    mk("M2", "delivered", 200000, { vat: 20000, created: "2026-10-31 19:00:00" }) // PKT 2026-11-01 00:00:00
  );

  // --- E: items JSON edge cases, all delivered, 2026-11-11 ---
  const phantom = () => [IR(9100, "DASH2 Phantom", 100000, 50)];
  const E = (n, items, o = {}) =>
    specs.push(
      mk(`E${pad2(n)}`, "delivered", 1000 + n, {
        vat: 100, created: `2026-11-11 ${pad2(n)}:00:00`, items, rows: o.rows || phantom(), lines: o.lines || [],
      })
    );
  E(1, "[]"); // handled, zero lines; order_items fallback suppressed
  E(2, "null"); // JSON null -> [] handled
  E(3, '"str"'); // malformed -> skipped (and order_items suppressed)
  E(4, JSON.stringify([{ name: "X", qty: -1, price: 1 }])); // negative qty -> skipped
  E(5, '{"name":"X"}'); // object not array -> skipped
  E(6, "   "); // whitespace -> [] handled
  E(7, JSON.stringify([{ name: "  DASH2 Trim Me  ", quantity: "3", unit_price: "10.5", product_id: null }]), {
    lines: [EL(null, "DASH2 Trim Me", 3, 3150)],
  });
  E(8, JSON.stringify([{ name: "DASH2 چائے کا کپ ☕", qty: 4, price: 250, product_id: 601 }]), {
    lines: [EL(601, "DASH2 چائے کا کپ ☕", 4, 100000)],
  });
  E(9, JSON.stringify([{ qty: 1, price: 5 }])); // missing name -> skipped
  E(10, null, {
    // order_items fallback; blank / whitespace names skipped
    rows: [IR(701, "", 1000, 1), IR(703, "   ", 1000, 1), IR(702, "DASH2 Real", 1000, 1)],
    lines: [EL(702, "DASH2 Real", 1, 1000)],
  });

  // --- OP: oldest pending (ties on created_at resolved by insertion id) ---
  specs.push(
    mk("OP1", "pending", 11100, { vat: 1000, created: "2026-09-01 10:00:00" }),
    mk("OP2", "pending", 22200, { vat: 2000, created: "2026-09-01 10:00:00" }),
    mk("OP3", "pending", 33300, { vat: null, created: "2026-08-15 08:00:00" }),
    mk("OPX", "cancelled", 44400, { vat: 0, created: "2026-07-01 00:00:00", cancel: "Duplicate order" }) // older but not pending
  );

  // --- B: 125 generated orders, 2026-10-15 00:00 UTC + i*3h (ends 2026-10-30 15:00) ---
  const base = Date.UTC(2026, 9, 15, 0, 0, 0);
  const cycle = ["pending", "confirmed", "dispatched", "delivered", "cancelled", "delivered"];
  const pms = ["cod", "jazzcash", "easypaisa", "bank_transfer", null, "", "  cod "];
  const coupons = [null, "SAVE10", "save10", " Eid20 ", "", "WELCOME", null, "eid20"];
  const reasonPick = [0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1];
  const reasons = [
    PRESET_LABELS[0],
    PRESET_LABELS[1],
    PRESET_LABELS[2],
    PRESET_LABELS[3],
    PRESET_LABELS[4],
    "Other",
    "Customer asked to cancel via WhatsApp",
    null,
    "",
    `  ${PRESET_LABELS[4]}  `, // padded preset -> still the preset
    "گاہک نے منسوخ کیا",
    "out of stock", // wrong case -> Other
  ];
  let d = 0; // delivered counter
  let k = 0; // cancelled counter
  for (let i = 0; i < 125; i++) {
    const status = cycle[i % 6];
    const totalC = 15000 + ((i * 1337) % 90000);
    const o = {
      created: utcStr(base + i * 3 * 3600000),
      vat: i % 11 === 0 ? null : Math.round(totalC * 0.15),
      pm: pms[i % 7],
      coupon: coupons[i % 8],
      email: i % 13 === 5 ? null : i % 13 === 6 ? "" : `c${i % 23}@dash2.test`,
      rows: [],
      lines: [],
    };
    o.disc = o.coupon && i % 4 !== 0 ? ((i % 5) + 1) * 1000 : null;
    if (status === "cancelled") {
      o.cancel = reasons[reasonPick[k % reasonPick.length]];
      k++;
    } else if (i % 12 === 1) {
      o.cancel = "Out of stock"; // must NOT count: only cancelled orders feed cancel_reasons
    }
    if (status === "delivered") {
      const m = d % 5;
      d++;
      if (m === 0) {
        o.rows = [IR(9001, "DASH2 Bulk Item", 2550, 2)];
        o.lines = [EL(9001, "DASH2 Bulk Item", 2, 5100)];
      } else if (m === 1) {
        o.items = JSON.stringify([{ name: "DASH2 Café ☕ Mug 🧃", qty: 1, price: 300, product_id: 9002 }]);
        o.lines = [EL(9002, "DASH2 Café ☕ Mug 🧃", 1, 30000)];
      } else if (m === 2) {
        o.items = '{"name": broken'; // malformed -> whole order skipped incl. order_items
        o.rows = phantom();
      } else if (m === 3) {
        o.items = JSON.stringify([{ product_name: "DASH2 JSON Tee", quantity: 3, unit_price: 120.5, product_id: 9003 }]);
        o.rows = phantom(); // valid items win; order_items must not double count
        o.lines = [EL(9003, "DASH2 JSON Tee", 3, 36150)];
      } else {
        o.items = ""; // empty string -> fall through to order_items
        o.rows = [IR(9001, "DASH2 Bulk Item", 2550, 1)];
        o.lines = [EL(9001, "DASH2 Bulk Item", 1, 2550)];
      }
    } else {
      if (i % 4 === 0) o.rows = [IR(900, "DASH2 Ghost", 5000, 7)];
      if (i % 9 === 2) o.items = JSON.stringify([{ name: "DASH2 Ghost", qty: 9, price: 99 }]);
    }
    specs.push(mk(`B${String(i).padStart(3, "0")}`, status, totalC, o));
  }
  return specs;
}

async function seedDash2(specs) {
  await pool.query("DELETE FROM order_items WHERE order_id LIKE 'DASH2-%'");
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'DASH2-%'");
  for (const s of specs) {
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, total, vat_amount, discount_amount,
         coupon_code, status, payment_method, cancel_reason, items, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id,
        "Dash2 Customer",
        s.email,
        "0300",
        s.total / 100,
        s.vat === null ? null : s.vat / 100,
        s.disc === null ? null : s.disc / 100,
        s.coupon,
        s.status,
        s.pm,
        s.cancel,
        s.items,
        s.created,
      ]
    );
    for (const r of s.rows) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?,?,?,?,?)",
        [s.id, r.pid, r.name, r.price / 100, r.qty]
      );
    }
  }
}

// ---- low-stock product seed ----
const LS = [
  // name suffix, track, stock, active
  ["A zero", 1, 0, 1],
  ["B five", 1, 5, 1],
  ["C six", 1, 6, 1],
  ["D untracked", 0, 1, 1],
  ["E nullstock", 1, null, 1],
  ["F inactive", 1, 3, 0],
  ["G activeNull", 1, 2, null],
  ["H کمی اسٹاک ☕", 1, 4, 1],
  ["M1", 1, 1, 1],
  ["M2", 1, 1, 1],
  ["M3", 1, 2, 1],
  ["M4", 1, 3, 1],
  ["M5", 1, 3, 1],
  ["M6", 1, 4, 1],
  ["M7", 1, 5, 1],
  ["M8", 1, 5, 1],
  ["N ten", 1, 10, 1],
  ["O hundred", 1, 100, 1],
  ["P negative", 1, -2, 1],
  ["Q nine-thousand", 1, 9999, 1],
];
const lsName = (s) => `DASH2-LS-${s}`;

async function seedLowStock() {
  await pool.query("DELETE FROM products WHERE name LIKE 'DASH2-%'");
  let n = 0;
  for (const [suffix, track, stock, active] of LS) {
    n++;
    await pool.query(
      "INSERT INTO products (name, slug, track_inventory, stock_quantity, active) VALUES (?,?,?,?,?)",
      [lsName(suffix), `dash2-ls-${n}`, track, stock, active]
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Mirror of the endpoint loaders (SQL copied from pages/api/admin-dashboard-summary.ts), scoped
// to DASH2-%. Pure rules come from the real lib.
// ---------------------------------------------------------------------------------------------
const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
function dateClause(range, alias = "o") {
  return range
    ? { sql: ` ${alias}.created_at >= ? AND ${alias}.created_at < ? `, params: [range[0], range[1]] }
    : { sql: " 1=1 ", params: [] };
}
const SC = "o.order_id LIKE 'DASH2-%'";

function makeMirror(lib) {
  async function summary(range) {
    const w = range ? " AND created_at >= ? AND created_at < ? " : "";
    const p = range ? [range[0], range[1]] : [];
    const [aggRows] = await pool.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_orders,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN 1 ELSE 0 END), 0) AS confirmed_sales_count,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN total ELSE 0 END), 0) AS pending_incl,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS pending_excl,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN total ELSE 0 END), 0) AS confirmed_incl,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS confirmed_excl,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN COALESCE(vat_amount, 0) ELSE 0 END), 0) AS tax_on_confirmed,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total ELSE 0 END), 0) AS revenue_incl,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS revenue_excl,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN COALESCE(vat_amount, 0) ELSE 0 END), 0) AS tax_on_revenue,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total ELSE 0 END), 0) AS cancelled_incl,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS cancelled_excl,
        COALESCE(SUM(CASE WHEN vat_amount IS NULL THEN 1 ELSE 0 END), 0) AS vat_null_orders
      FROM orders
      WHERE order_id LIKE 'DASH2-%' ${w}`,
      p
    );
    const [custRows] = await pool.query(
      `SELECT COUNT(*) AS customer_count FROM (
         SELECT customer_email FROM orders
         WHERE order_id LIKE 'DASH2-%' ${w} AND
           customer_email IS NOT NULL AND customer_email != ''
         GROUP BY customer_email
       ) t`,
      p
    );
    const a = aggRows[0];
    return {
      total_orders: n(a.total_orders),
      pending_orders: n(a.pending_orders),
      delivered_orders: n(a.delivered_orders),
      cancelled_orders: n(a.cancelled_orders),
      confirmed_count: n(a.confirmed_sales_count),
      pending_incl: cents(a.pending_incl),
      pending_excl: cents(a.pending_excl),
      confirmed_incl: cents(a.confirmed_incl),
      confirmed_excl: cents(a.confirmed_excl),
      tax_on_confirmed: cents(a.tax_on_confirmed),
      revenue_incl: cents(a.revenue_incl),
      revenue_excl: cents(a.revenue_excl),
      tax_on_revenue: cents(a.tax_on_revenue),
      cancelled_incl: cents(a.cancelled_incl),
      cancelled_excl: cents(a.cancelled_excl),
      vat_null_orders: n(a.vat_null_orders),
      customer_count: n(custRows[0].customer_count),
    };
  }

  async function revenueTrend(bucket, range) {
    const keyExpr =
      bucket === "month"
        ? `DATE_FORMAT(DATE_ADD(created_at, INTERVAL 5 HOUR), '%Y-%m')`
        : `DATE_FORMAT(DATE_ADD(created_at, INTERVAL 5 HOUR), '%Y-%m-%d')`;
    const date = dateClause(range);
    const [rows] = await pool.query(
      `SELECT ${keyExpr} AS bucket_key,
              COALESCE(SUM(total), 0) AS incl,
              COALESCE(SUM(total - COALESCE(vat_amount, 0)), 0) AS excl
       FROM orders o
       WHERE o.status = 'delivered' AND ${SC} AND ${date.sql}
       GROUP BY bucket_key
       ORDER BY bucket_key ASC`,
      date.params
    );
    const points = rows.map((r) => ({ key: String(r.bucket_key), incl: cents(r.incl), excl: cents(r.excl) }));
    return { bucket, points: lib.capTrendPoints(points.map((p) => ({ ...p, label: p.key }))).map(({ key, incl, excl }) => ({ key, incl, excl })) };
  }

  async function topProducts(range) {
    const date = dateClause(range);
    const skip = new Set();
    const handled = new Set();
    const lines = [];
    const [ordRows] = await pool.query(
      `SELECT o.order_id, o.items FROM orders o WHERE o.status = 'delivered' AND ${SC} AND ${date.sql}`,
      date.params
    );
    for (const row of ordRows) {
      const oid = String(row.order_id || "");
      if (row.items === null || row.items === undefined || row.items === "") continue;
      const parsed = lib.parseOrderItemsJson(row.items);
      if (parsed === null) {
        skip.add(oid);
        continue;
      }
      handled.add(oid);
      for (const p of parsed) lines.push(p);
    }
    const [itemRows] = await pool.query(
      `SELECT o.order_id, oi.product_id, oi.product_name, oi.price, oi.quantity
       FROM orders o INNER JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.status = 'delivered' AND ${SC} AND ${date.sql}`,
      date.params
    );
    for (const row of itemRows) {
      const oid = String(row.order_id || "");
      if (!oid || skip.has(oid) || handled.has(oid)) continue;
      const name = String(row.product_name || "").trim();
      if (!name) continue;
      const units = n(row.quantity);
      const price = n(row.price);
      lines.push({ product_id: row.product_id == null ? null : n(row.product_id), name, units, revenue: units * price });
    }
    return { lines, top: lib.aggregateTopProducts(lines) };
  }

  async function lowStock() {
    let threshold = lib.LOW_STOCK_DEFAULT;
    const [cRows] = await pool.query(`SELECT content_value FROM site_content WHERE content_key = ? LIMIT 1`, [
      lib.LOW_STOCK_CONTENT_KEY,
    ]);
    threshold = lib.resolveLowStockThreshold(cRows[0] ? cRows[0].content_value : null);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM products
       WHERE name LIKE 'DASH2-%' AND track_inventory = 1
         AND (active = 1 OR active IS NULL)
         AND stock_quantity IS NOT NULL
         AND stock_quantity <= ?`,
      [threshold]
    );
    const [listRows] = await pool.query(
      `SELECT id, name, stock_quantity FROM products
       WHERE name LIKE 'DASH2-%' AND track_inventory = 1
         AND (active = 1 OR active IS NULL)
         AND stock_quantity IS NOT NULL
         AND stock_quantity <= ?
       ORDER BY stock_quantity ASC, id ASC
       LIMIT 10`,
      [threshold]
    );
    return {
      threshold,
      count: n(countRows[0].c),
      products: listRows.map((r) => ({ name: String(r.name), stock_quantity: n(r.stock_quantity) })),
    };
  }

  async function cancelReasons(range) {
    const date = dateClause(range);
    const [rows] = await pool.query(
      `SELECT cancel_reason FROM orders o WHERE o.status = 'cancelled' AND ${SC} AND ${date.sql}`,
      date.params
    );
    const counts = new Map();
    for (const row of rows) {
      const r = lib.bucketCancelReason(row.cancel_reason);
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 5);
  }

  async function paymentSplit(range) {
    const date = dateClause(range);
    const [rows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(payment_method), ''), 'unknown') AS method,
              COUNT(*) AS cnt,
              COALESCE(SUM(total), 0) AS total
       FROM orders o
       WHERE o.status <> 'cancelled' AND ${SC} AND ${date.sql}
       GROUP BY method
       ORDER BY cnt DESC, method ASC`,
      date.params
    );
    return rows.map((r) => ({ method: String(r.method), count: n(r.cnt), total: cents(r.total) }));
  }

  async function oldestPending() {
    const [rows] = await pool.query(
      `SELECT order_id, total, created_at FROM orders o
       WHERE o.status = 'pending' AND ${SC}
       ORDER BY created_at ASC, id ASC
       LIMIT 5`
    );
    return rows.map((r) => ({ order_id: String(r.order_id), total: cents(r.total) }));
  }

  async function couponUsage(range) {
    const date = dateClause(range);
    const [rows] = await pool.query(
      `SELECT UPPER(TRIM(coupon_code)) AS code,
              COUNT(*) AS orders,
              COALESCE(SUM(COALESCE(discount_amount, 0)), 0) AS discount_total
       FROM orders o
       WHERE coupon_code IS NOT NULL AND TRIM(coupon_code) <> '' AND ${SC} AND ${date.sql}
       GROUP BY code
       ORDER BY orders DESC, code ASC`,
      date.params
    );
    return rows.map((r) => ({ code: String(r.code), orders: n(r.orders), discount_total: cents(r.discount_total) }));
  }

  return { summary, revenueTrend, topProducts, lowStock, cancelReasons, paymentSplit, oldestPending, couponUsage };
}

// ---------------------------------------------------------------------------------------------
// JS expectation model (independent of lib helpers and of the SQL)
// ---------------------------------------------------------------------------------------------
function inRange(s, range) {
  return !range || (s.created >= range[0] && s.created < range[1]);
}
const sumC = (arr, f) => arr.reduce((a, s) => a + f(s), 0);

function modelSummary(specs, range) {
  const set = specs.filter((s) => inRange(s, range));
  const by = (st) => set.filter((s) => s.status === st);
  const conf = set.filter((s) => CONFIRMED.has(s.status));
  const vat = (s) => s.vat ?? 0;
  const emails = new Set(set.map((s) => s.email).filter((e) => e));
  return {
    total_orders: set.length,
    pending_orders: by("pending").length,
    delivered_orders: by("delivered").length,
    cancelled_orders: by("cancelled").length,
    confirmed_count: conf.length,
    pending_incl: sumC(by("pending"), (s) => s.total),
    pending_excl: sumC(by("pending"), (s) => s.total - vat(s)),
    confirmed_incl: sumC(conf, (s) => s.total),
    confirmed_excl: sumC(conf, (s) => s.total - vat(s)),
    tax_on_confirmed: sumC(conf, vat),
    revenue_incl: sumC(by("delivered"), (s) => s.total),
    revenue_excl: sumC(by("delivered"), (s) => s.total - vat(s)),
    tax_on_revenue: sumC(by("delivered"), vat),
    cancelled_incl: sumC(by("cancelled"), (s) => s.total),
    cancelled_excl: sumC(by("cancelled"), (s) => s.total - vat(s)),
    vat_null_orders: set.filter((s) => s.vat === null).length,
    customer_count: emails.size,
  };
}

function modelTrend(specs, bucket, range) {
  const m = new Map();
  for (const s of specs.filter((x) => x.status === "delivered" && inRange(x, range))) {
    const key = pktKey(s.created, bucket === "month" ? 7 : 10);
    const cur = m.get(key) || { key, incl: 0, excl: 0 };
    cur.incl += s.total;
    cur.excl += s.total - (s.vat ?? 0);
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function modelTop(specs, range) {
  const map = new Map();
  for (const s of specs.filter((x) => x.status === "delivered" && inRange(x, range))) {
    for (const l of s.lines) {
      const key = `${l.pid ?? "x"}::${l.name}`;
      const cur = map.get(key) || { product_id: l.pid, name: l.name, units: 0, revC: 0 };
      cur.units += l.units;
      cur.revC += l.rev;
      map.set(key, cur);
    }
  }
  const all = [...map.values()];
  const fmt = (r) => ({ product_id: r.product_id, name: r.name, units: r.units, revC: r.revC });
  return {
    map,
    by_units: [...all].sort((a, b) => b.units - a.units || b.revC - a.revC || a.name.localeCompare(b.name)).slice(0, 5).map(fmt),
    by_revenue: [...all].sort((a, b) => b.revC - a.revC || b.units - a.units || a.name.localeCompare(b.name)).slice(0, 5).map(fmt),
  };
}

function modelCancel(specs, range) {
  const counts = new Map();
  for (const s of specs.filter((x) => x.status === "cancelled" && inRange(x, range))) {
    const t = typeof s.cancel === "string" ? s.cancel.trim() : "";
    const b = PRESET_LABELS.includes(t) ? t : "Other";
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

function modelPayments(specs, range) {
  const m = new Map();
  for (const s of specs.filter((x) => x.status !== "cancelled" && inRange(x, range))) {
    const key = (s.pm ?? "").trim() || "unknown";
    const cur = m.get(key) || { method: key, count: 0, total: 0 };
    cur.count++;
    cur.total += s.total;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
}

function modelCoupons(specs, range) {
  const m = new Map();
  for (const s of specs.filter((x) => inRange(x, range))) {
    const code = (s.coupon ?? "").trim().toUpperCase();
    if (!code) continue;
    const cur = m.get(code) || { code, orders: 0, discount_total: 0 };
    cur.orders++;
    cur.discount_total += s.disc ?? 0;
    m.set(code, cur);
  }
  return [...m.values()].sort((a, b) => b.orders - a.orders || (a.code < b.code ? -1 : 1));
}

function modelOldestPending(specs) {
  return specs
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.status === "pending")
    .sort((a, b) => (a.s.created < b.s.created ? -1 : a.s.created > b.s.created ? 1 : a.idx - b.idx))
    .slice(0, 5)
    .map(({ s }) => ({ order_id: s.id, total: s.total }));
}

function modelLowStock(threshold) {
  const rows = LS.map(([suffix, track, stock, active], i) => ({ name: lsName(suffix), track, stock, active, i }))
    .filter((r) => r.track === 1 && (r.active === 1 || r.active === null) && r.stock !== null && r.stock <= threshold)
    .sort((a, b) => a.stock - b.stock || a.i - b.i);
  return { count: rows.length, products: rows.slice(0, 10).map((r) => ({ name: r.name, stock_quantity: r.stock })) };
}

// ---------------------------------------------------------------------------------------------
// Assertions on DASH2 data
// ---------------------------------------------------------------------------------------------
async function dash2Assertions(lib, specs) {
  const mirror = makeMirror(lib);
  const stats = {};

  eq(specs.length, 150, "seed size");
  eq(new Set(specs.map((s) => s.id)).size, 150, "unique ids");
  const [[cnt]] = await pool.query("SELECT COUNT(*) AS c FROM orders WHERE order_id LIKE 'DASH2-%'");
  eq(Number(cnt.c), 150);

  // seed sanity: coverage of the matrix the test claims to cover
  const statuses = new Set(specs.map((s) => s.status));
  eq([...statuses].sort(), ["cancelled", "confirmed", "delivered", "dispatched", "pending"]);
  ok(specs.some((s) => s.vat === null), "legacy NULL tax present");
  ok(specs.some((s) => s.pm === null) && specs.some((s) => s.pm === "") && specs.some((s) => s.pm === "  cod "), "payment edge values");
  ok(specs.some((s) => s.status === "delivered" && s.items === '{"name": broken'), "malformed items on delivered orders");

  // ---------- ranges ----------
  const WIN = pktRange("2026-11-05", "2026-11-07");
  eq(WIN, ["2026-11-04 19:00:00", "2026-11-07 19:00:00"], "PKT -> UTC range conversion");
  const MRANGE = pktRange("2026-10-31", "2026-11-01");
  eq(MRANGE, ["2026-10-30 19:00:00", "2026-11-01 19:00:00"]);
  const WIDE = pktRange("2026-10-01", "2026-11-12");
  const ranges = { all: null, win: WIN, mrange: MRANGE, wide: WIDE, empty: pktRange("2099-01-01", "2099-01-02") };

  // ---------- summary aggregates (all ranges vs model) ----------
  for (const [name, r] of Object.entries(ranges)) {
    eq(await mirror.summary(r), modelSummary(specs, r), `summary ${name}`);
  }
  // Hand-computed window literals
  const w = await mirror.summary(WIN);
  eq(w.total_orders, 7);
  eq(w.pending_orders, 1);
  eq(w.delivered_orders, 5);
  eq(w.cancelled_orders, 1);
  eq(w.confirmed_count, 5);
  eq(w.revenue_incl, 102000, "200+300+400+50+70");
  eq(w.revenue_excl, 94800, "180+300(null vat)+360+45+63");
  eq(w.tax_on_revenue, 7200);
  eq(w.pending_incl, 999900);
  eq(w.pending_excl, 999900);
  eq(w.cancelled_incl, 888800);
  eq(w.cancelled_excl, 888800, "NULL vat treated as 0");
  eq(w.vat_null_orders, 2, "T3 + WC");
  eq(w.customer_count, 3, "w1,w2,w3 (NULL and '' excluded, w1 deduped)");
  // Full-set literal sanity
  const all = await mirror.summary(null);
  eq(all.total_orders, 150);
  ok(all.vat_null_orders >= 12, "legacy null-tax rows seeded");
  // empty range
  eq((await mirror.summary(ranges.empty)).total_orders, 0);
  eq((await mirror.summary(ranges.empty)).revenue_incl, 0);

  // ---------- revenue_trend ----------
  eq(await mirror.revenueTrend("month", null), { bucket: "month", points: modelTrend(specs, "month", null) }, "trend all/month");
  eq(await mirror.revenueTrend("day", WIDE), { bucket: "day", points: modelTrend(specs, "day", WIDE) }, "trend wide/day");
  const tw = await mirror.revenueTrend("day", WIN);
  eq(tw.points, [
    { key: "2026-11-05", incl: 50000, excl: 48000 },
    { key: "2026-11-06", incl: 45000, excl: 40500 },
    { key: "2026-11-07", incl: 7000, excl: 6300 },
  ], "window day buckets: PKT midnight boundaries, pending/cancelled excluded");
  eq(
    (await mirror.revenueTrend("day", MRANGE)).points,
    [
      { key: "2026-10-31", incl: 100000, excl: 90000 },
      { key: "2026-11-01", incl: 200000, excl: 180000 },
    ],
    "day buckets across PKT month boundary"
  );
  eq(
    (await mirror.revenueTrend("month", MRANGE)).points,
    [
      { key: "2026-10", incl: 100000, excl: 90000 },
      { key: "2026-11", incl: 200000, excl: 180000 },
    ],
    "month buckets across PKT month boundary"
  );
  eq((await mirror.revenueTrend("day", ranges.empty)).points, []);
  const allMonths = (await mirror.revenueTrend("month", null)).points;
  eq(allMonths.map((p) => p.key), ["2026-10", "2026-11"], "all-time monthly bucket keys");
  // monthly points sum to total delivered revenue
  eq(sumC(allMonths, (p) => p.incl), all.revenue_incl);
  eq(sumC(allMonths, (p) => p.excl), all.revenue_excl);
  // day-bucket sums equal the summary for the same range
  const wideDay = (await mirror.revenueTrend("day", WIDE)).points;
  eq(sumC(wideDay, (p) => p.incl), (await mirror.summary(WIDE)).revenue_incl);

  // ---------- top_products ----------
  for (const [name, r] of [["all", null], ["win", WIN], ["wide", WIDE], ["empty", ranges.empty]]) {
    const got = await mirror.topProducts(r);
    const exp = modelTop(specs, r);
    // line-level aggregation must match the hand-specified per-order lines
    const gotMap = new Map();
    for (const l of got.lines) {
      const key = `${l.product_id ?? "x"}::${l.name}`;
      const cur = gotMap.get(key) || { units: 0, revC: 0 };
      cur.units += l.units;
      cur.revC += Math.round(l.revenue * 100);
      gotMap.set(key, cur);
    }
    eq(
      [...gotMap.entries()].sort(),
      [...exp.map.entries()].map(([k, v]) => [k, { units: v.units, revC: v.revC }]).sort(),
      `top lines ${name}`
    );
    const norm = (rows) => rows.map((x) => ({ product_id: x.product_id, name: x.name, units: x.units, revC: Math.round((x.revenue ?? x.revC / 100) * 100) }));
    eq(norm(got.top.by_units).map((x) => [x.name, x.units, x.revC]), exp.by_units.map((x) => [x.name, x.units, x.revC]), `by_units ${name}`);
    eq(norm(got.top.by_revenue).map((x) => [x.name, x.units, x.revC]), exp.by_revenue.map((x) => [x.name, x.units, x.revC]), `by_revenue ${name}`);
    for (const l of got.lines) {
      noMatch(l.name, /Phantom|Ghost/, `${name}: skipped/non-delivered line leaked: ${l.name}`);
    }
  }
  const topWin = (await mirror.topProducts(WIN)).top;
  eq(
    topWin.by_units.map((r) => [r.name, r.units, cents(r.revenue)]),
    [
      ["DASH2 Edge B", 3, 50000], // order_items (2x100) + JSON items (1x300), same pid -> merged
      ["DASH2 Edge E", 2, 7000],
      ["DASH2 Édge ✓ 日本", 1, 40000],
      ["DASH2 Edge D", 1, 5000],
    ],
    "window by_units (hand-computed, ties by revenue)"
  );
  eq(
    topWin.by_revenue.map((r) => r.name),
    ["DASH2 Edge B", "DASH2 Édge ✓ 日本", "DASH2 Edge E", "DASH2 Edge D"],
    "window by_revenue"
  );
  const topAll = (await mirror.topProducts(null)).top;
  ok(topAll.by_units.length === 5 && topAll.by_revenue.length === 5);
  eq(topAll.by_units[0].name, "DASH2 Bulk Item", "bulk item leads by units");
  // Specific hand-computed edge lines are present in the all-range line set
  const allLines = (await mirror.topProducts(null)).lines;
  const find = (name) => allLines.filter((l) => l.name === name);
  eq(find("DASH2 Trim Me").map((l) => [l.product_id, l.units, l.revenue]), [[null, 3, 31.5]], "trimmed name, string qty/price, null pid");
  eq(find("DASH2 چائے کا کپ ☕").map((l) => [l.product_id, l.units, l.revenue]), [[601, 4, 1000]], "unicode name");
  eq(find("DASH2 Real").length, 1, "order_items fallback");
  eq(allLines.filter((l) => l.name === "" || l.name.trim() === "").length, 0, "blank order_items names skipped");
  stats.bulkUnits = find("DASH2 Bulk Item").reduce((a, l) => a + l.units, 0);

  // ---------- cancel_reasons ----------
  for (const [name, r] of Object.entries(ranges)) {
    eq(await mirror.cancelReasons(r), modelCancel(specs, r), `cancel_reasons ${name}`);
  }
  eq(await mirror.cancelReasons(WIN), [{ reason: "Out of stock", count: 1 }]);
  const cr = await mirror.cancelReasons(null);
  ok(cr.length === 5, "capped to 5 buckets (6 exist)");
  ok(cr.every((x, i) => i === 0 || cr[i - 1].count >= x.count), "sorted by count desc");
  // non-cancelled orders with cancel_reason never counted
  const cancelledCount = specs.filter((s) => s.status === "cancelled").length;
  const sixBuckets = (() => {
    const set = new Set(specs.filter((s) => s.status === "cancelled").map((s) => (PRESET_LABELS.includes((s.cancel ?? "").trim?.() ?? "") ? s.cancel.trim() : "Other")));
    return set.size;
  })();
  eq(sixBuckets, 6, "six distinct buckets seeded (5 presets + Other)");
  ok(cr.reduce((a, x) => a + x.count, 0) < cancelledCount, "slice(0,5) dropped the smallest bucket");

  // ---------- payment_methods ----------
  for (const [name, r] of Object.entries(ranges)) {
    eq(await mirror.paymentSplit(r), modelPayments(specs, r), `payment_methods ${name}`);
  }
  eq(
    await mirror.paymentSplit(WIN),
    [
      { method: "cod", count: 3, total: 1026900 }, // 200 + 70 + 9999 (pending counts; cancelled never)
      { method: "easypaisa", count: 1, total: 5000 },
      { method: "jazzcash", count: 1, total: 30000 }, // cancelled jazzcash WC excluded
      { method: "unknown", count: 1, total: 40000 }, // NULL -> unknown
    ],
    "window payment split (hand-computed)"
  );
  const pAll = await mirror.paymentSplit(null);
  ok(pAll.some((x) => x.method === "unknown"), "NULL/'' folded to unknown");
  eq(pAll.filter((x) => x.method === "cod").length, 1, "'  cod ' trimmed into cod");
  eq(sumC(pAll, (x) => x.count), specs.filter((s) => s.status !== "cancelled").length);

  // ---------- oldest_pending ----------
  const op = await mirror.oldestPending();
  eq(op, modelOldestPending(specs), "oldest_pending vs model");
  eq(op.slice(0, 3).map((x) => x.order_id), ["DASH2-OP3", "DASH2-OP1", "DASH2-OP2"], "oldest first, ties by id; cancelled OPX ignored");
  eq(op.length, 5);
  eq(op[0].total, 33300);
  eq(op[3].order_id, "DASH2-B000", "next oldest is first bulk pending");

  // ---------- coupon_usage ----------
  for (const [name, r] of Object.entries(ranges)) {
    eq(await mirror.couponUsage(r), modelCoupons(specs, r), `coupon_usage ${name}`);
  }
  eq(
    await mirror.couponUsage(WIN),
    [
      { code: "WINTER", orders: 2, discount_total: 2000 }, // WINTER + winter, one NULL discount
      { code: "SAVE10", orders: 1, discount_total: 5000 }, // cancelled orders still count
    ],
    "window coupon usage (hand-computed)"
  );
  const cu = await mirror.couponUsage(null);
  eq(cu.filter((x) => x.code === "SAVE10").length, 1, "save10/SAVE10 merged");
  eq(cu.filter((x) => x.code === "EID20").length, 1, "' Eid20 '/eid20 merged");
  ok(!cu.some((x) => x.code === ""), "blank coupons excluded");
  ok(cu.every((x, i) => i === 0 || cu[i - 1].orders >= x.orders), "sorted by orders desc");

  // ---------- low_stock ----------
  const [prevRows] = await pool.query("SELECT content_value, content_type, page_name, label FROM site_content WHERE content_key = ?", [lib.LOW_STOCK_CONTENT_KEY]);
  const prev = prevRows[0] || null;
  try {
    await pool.query("DELETE FROM site_content WHERE content_key = ?", [lib.LOW_STOCK_CONTENT_KEY]);
    const absent = await mirror.lowStock();
    eq(absent.threshold, 5, "default threshold when site_content row missing");
    eq(absent, { threshold: 5, ...modelLowStock(5) }, "low_stock default");
    eq(absent.count, 13, "A0,B5,G2,H4,M1..M8,P-2");
    eq(absent.products.length, 10, "list capped at 10 while count is 13");
    eq(
      absent.products.slice(0, 4).map((p) => p.name),
      [lsName("P negative"), lsName("A zero"), lsName("M1"), lsName("M2")],
      "ordered by stock asc then id asc"
    );
    ok(!absent.products.some((p) => /untracked|nullstock|inactive|six|ten|hundred/.test(p.name)), "untracked/NULL/inactive/above-threshold excluded");
    const names5 = new Set((await mirror.lowStock()).products.map((p) => p.name));
    ok(!names5.has(lsName("C six")));

    for (const [stored, want] of [
      ["10", 10],
      ["0", 0],
      ["3", 3],
      ["9999", 9999],
      ["abc", 5],
      ["", 5],
      [" ", 5],
      ["10000", 5],
      ["-1", 5],
      ["2.5", 5],
      [" 7 ", 7],
    ]) {
      await pool.query(
        `INSERT INTO site_content (content_key, content_value, content_type, page_name, label)
         VALUES (?,?, 'text','settings','Admin low-stock threshold')
         ON DUPLICATE KEY UPDATE content_value = VALUES(content_value)`,
        [lib.LOW_STOCK_CONTENT_KEY, stored]
      );
      const got = await mirror.lowStock();
      eq(got.threshold, want, `threshold for stored ${JSON.stringify(stored)}`);
      eq(got, { threshold: want, ...modelLowStock(want) }, `low_stock list for stored ${JSON.stringify(stored)}`);
    }
    // literal spot checks
    await pool.query("UPDATE site_content SET content_value = '0' WHERE content_key = ?", [lib.LOW_STOCK_CONTENT_KEY]);
    eq((await mirror.lowStock()).products.map((p) => p.name), [lsName("P negative"), lsName("A zero")], "threshold 0 -> only stock<=0");
    await pool.query("UPDATE site_content SET content_value = '9999' WHERE content_key = ?", [lib.LOW_STOCK_CONTENT_KEY]);
    const maxT = await mirror.lowStock();
    eq(maxT.count, 17, "A,B,C,G,H + M1-8 + N,O,P,Q (untracked/NULL/inactive still excluded)");
    eq(maxT.products.length, 10);
  } finally {
    await pool.query("DELETE FROM site_content WHERE content_key = ?", [lib.LOW_STOCK_CONTENT_KEY]);
    if (prev) {
      await pool.query(
        "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES (?,?,?,?,?)",
        [lib.LOW_STOCK_CONTENT_KEY, prev.content_value, prev.content_type, prev.page_name, prev.label]
      );
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// 4. Source checks
// ---------------------------------------------------------------------------------------------
async function sourceChecks() {
  const src = await fs.readFile(path.join(root, "pages/api/admin-dashboard-summary.ts"), "utf8");
  match(src, /requireRole\(req, res, \["super_admin", "manager"\]\)/);
  match(src, /Cache-Control.*private, no-store/);
  match(src, /Invalid date range/);
  match(src, /Asia\/Karachi/);
  match(src, /method !== "GET"/);
  match(src, /session\.role !== "super_admin"/);
  match(src, /session\.role !== "manager"/);
  noMatch(src, /admin-orders/);
  noMatch(src, /requireRole\(req, res, \[[^\]]*"writer"/, "writers must never be granted dashboard access");
  // response keys (additive extras)
  for (const key of [
    "revenue_trend",
    "top_products",
    "low_stock",
    "cancel_reasons",
    "payment_methods",
    "oldest_pending",
    "coupon_usage",
  ]) {
    match(src, new RegExp(`\\b${key}\\b`), `extras key ${key} in endpoint`);
  }
  // existing DASH-01 keys stay
  for (const key of ["total_orders", "pending_value", "confirmed_sales", "tax_collected", "cancelled_value", "customer_count", "product_count", "vat_null_orders"]) {
    match(src, new RegExp(`\\b${key}\\b`), `legacy key ${key}`);
  }
  // SQL rules mirrored by this test — if these change, update the mirror
  match(src, /DATE_ADD\(created_at, INTERVAL 5 HOUR\)/);
  match(src, /preset === "all" \? "month" : "day"/);
  match(src, /o\.status = 'delivered' AND/);
  match(src, /o\.status <> 'cancelled' AND/);
  match(src, /UPPER\(TRIM\(coupon_code\)\)/);
  match(src, /COALESCE\(NULLIF\(TRIM\(payment_method\), ''\), 'unknown'\)/);
  match(src, /track_inventory = 1/);
  match(src, /\(active = 1 OR active IS NULL\)/);
  match(src, /stock_quantity IS NOT NULL/);
  match(src, /stock_quantity <= \?/);
  match(src, /ORDER BY stock_quantity ASC, id ASC\s+LIMIT 10/);
  match(src, /ORDER BY created_at ASC, id ASC\s+LIMIT 5/);
  match(src, /WHERE status = 'pending'/);
  match(src, /parseOrderItemsJson\(row\.items\)/);
  match(src, /skip\.add\(oid\)/);
  match(src, /skip\.has\(oid\) \|\| handled\.has\(oid\)/);
  match(src, /resolveLowStockThreshold\(raw\)/);
  match(src, /toSafeError\(err\)/);
  match(src, /Could not load dashboard summary/);
  noMatch(src, /err\.message\s*[,}]/, "no raw error message in response body");

  const sc = await fs.readFile(path.join(root, "pages/api/site-content.ts"), "utf8");
  match(sc, /LOW_STOCK_CONTENT_KEY/);
  match(sc, /parseLowStockThreshold\(value\)/);
  match(sc, /ContentValidationError/);
  match(sc, /res\.status\(400\)\.json\(\{ error: error\.message/);
  match(sc, /const session = await requireAdmin\(req, res\)/);
  match(sc, /String\(parsed\.value\)/);

  const lib = await fs.readFile(path.join(root, "lib/dashboardExtras.ts"), "utf8");
  match(lib, /LOW_STOCK_DEFAULT = 5/);
  match(lib, /LOW_STOCK_MAX = 9999/);
  match(lib, /TREND_MAX_POINTS = 90/);
  match(lib, /admin_low_stock_threshold/);
}

// ---------------------------------------------------------------------------------------------
async function cleanupDash2() {
  await pool.query("DELETE FROM order_items WHERE order_id LIKE 'DASH2-%'");
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'DASH2-%'");
  await pool.query("DELETE FROM products WHERE name LIKE 'DASH2-%'");
}

async function main() {
  ok(process.env.SANDY_TEST_DB_PASSWORD, "SANDY_TEST_DB_PASSWORD must be set");

  const { lib, cancelMod, dir } = await loadLib();
  try {
    pureHelperTests(lib, cancelMod);
    console.log("DASHBOARD_PURE_HELPERS_PASS", { asserts });
    const pureAsserts = asserts;

    await recreateSchema();
    await seedLegacy();
    const legacy = await legacyAssertions();
    const legacyAsserts = asserts - pureAsserts;
    console.log("DASHBOARD_LEGACY_AGGREGATE_PASS", { asserts: legacyAsserts, ...legacy });

    const specs = buildSeed();
    await seedDash2(specs);
    await seedLowStock();
    const before = asserts;
    const stats = await dash2Assertions(lib, specs);
    const dash2Asserts = asserts - before;
    console.log("DASHBOARD_EXTRAS_SQL_PASS", { asserts: dash2Asserts, orders: specs.length, ...stats });

    const b2 = asserts;
    await sourceChecks();
    console.log("DASHBOARD_ENDPOINT_SOURCE_PASS", { asserts: asserts - b2 });

    // Date validation helpers (mirror of resolveRange rules)
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    eq(ISO_DATE.test("2026-11-10"), true);
    eq(ISO_DATE.test("2026-13-40"), true); // format-only; calendar check is separate in the endpoint
    eq(ISO_DATE.test("bad"), false);

    const sourceAsserts = asserts - b2;
    await cleanupDash2();
    console.log("DASHBOARD_DB_AGGREGATE_PASS", {
      asserts,
      pure_helpers: pureAsserts,
      legacy_dash01: legacyAsserts,
      extras_sql: dash2Asserts,
      source_and_misc: sourceAsserts,
      orders_seeded: specs.length,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
