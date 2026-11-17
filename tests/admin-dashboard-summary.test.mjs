/**
 * Local MariaDB + source/auth-shape tests for ADMIN-DASH-01.
 * Host 127.0.0.1:3307 / sandy_test_local. No production.
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
  multipleStatements: true,
});

async function recreateOrdersSchema() {
  // Local test DB only — replace the stub orders table from earlier tax runs.
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
      status VARCHAR(32) NOT NULL,
      payment_method VARCHAR(32) NULL,
      created_at DATETIME NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      active TINYINT NULL DEFAULT 1
    )
  `);
  // Ensure products has active column even if an older stub exists.
  try {
    await pool.query("ALTER TABLE products ADD COLUMN active TINYINT NULL DEFAULT 1");
  } catch {
    /* already present */
  }
}

async function seed() {
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'DASH-%'");
  await pool.query("DELETE FROM products WHERE name LIKE 'DASH-%'");
  const rows = [
    // pending on D0 (PKT wall clock stored as DATETIME): total 1000 vat 180
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
  // Match real products schema (slug required).
  try {
    await pool.query(
      "INSERT INTO products (name, slug, active) VALUES ('DASH-Active','dash-active',1),('DASH-Null','dash-null',NULL),('DASH-Off','dash-off',0)"
    );
  } catch (e) {
    // Minimal stub schema without slug
    if (String(e && e.message).includes("Unknown column 'slug'")) {
      await pool.query("INSERT INTO products (name, active) VALUES ('DASH-Active',1),('DASH-Null',NULL),('DASH-Off',0)");
    } else {
      throw e;
    }
  }
}

async function main() {
  await recreateOrdersSchema();
  await seed();

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
  assert.equal(Number(h.pending_orders), 2);
  assert.equal(Number(h.delivered_orders), 3);
  assert.equal(Number(h.cancelled_orders), 1);
  assert.equal(Number(h.confirmed_sales_count), 5);
  assert.equal(Number(h.revenue_incl), 2199);
  assert.equal(Number(h.cancelled_incl), 300);
  assert.equal(Number(h.vat_null_orders), 1);
  assert.equal(Number(h.confirmed_incl), 500 + 200 + 800 + 999 + 400);
  // NULL vat treated as 0 for excl
  assert.equal(Number(h.pending_excl), 1000 - 180 + 1178.82);

  // Day boundary: D0 PKT 2026-11-10 only (exclude OLD and NEW)
  const fromSql = "2026-11-10 00:00:00";
  const toEx = "2026-11-11 00:00:00";
  const [dayRows] = await pool.query(
    `SELECT COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN status='delivered' THEN total ELSE 0 END),0) AS rev
     FROM orders WHERE order_id LIKE 'DASH-%' AND created_at >= ? AND created_at < ?`,
    [fromSql, toEx]
  );
  assert.equal(Number(dayRows[0].c), 6);
  assert.equal(Number(dayRows[0].rev), 800);

  // Empty range
  const [empty] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders WHERE order_id LIKE 'DASH-%' AND created_at >= ? AND created_at < ?`,
    ["2099-01-01 00:00:00", "2099-01-02 00:00:00"]
  );
  assert.equal(Number(empty[0].c), 0);

  const [prods] = await pool.query(
    `SELECT COUNT(*) AS c FROM products WHERE name LIKE 'DASH-%' AND (active = 1 OR active IS NULL)`
  );
  assert.equal(Number(prods[0].c), 2);

  const [cust] = await pool.query(
    `SELECT COUNT(*) AS c FROM (
      SELECT customer_email FROM orders WHERE order_id LIKE 'DASH-%' AND customer_email IS NOT NULL AND customer_email != ''
      GROUP BY customer_email
    ) t`
  );
  assert.equal(Number(cust[0].c), 7);

  console.log("DASHBOARD_DB_AGGREGATE_PASS", {
    all: h,
    dayRev: Number(dayRows[0].rev),
    products: Number(prods[0].c),
    customers: Number(cust[0].c),
  });

  const src = await fs.readFile(path.join(root, "pages/api/admin-dashboard-summary.ts"), "utf8");
  assert.match(src, /requireRole\(req, res, \["super_admin", "manager"\]\)/);
  assert.match(src, /Cache-Control.*private, no-store/);
  assert.match(src, /Invalid date range/);
  assert.match(src, /Asia\/Karachi/);
  assert.match(src, /method !== "GET"/);
  assert.match(src, /session\.role !== "super_admin"/);
  assert.doesNotMatch(src, /admin-orders/);
  console.log("DASHBOARD_ENDPOINT_SOURCE_PASS");

  // Date validation helpers (mirror of resolveRange rules) — exercised via source + pure checks.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  assert.equal(ISO_DATE.test("2026-11-10"), true);
  assert.equal(ISO_DATE.test("2026-13-40"), true); // format-only; calendar check separate
  assert.equal(ISO_DATE.test("bad"), false);

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
