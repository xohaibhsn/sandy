/**
 * HTTP auth/validation checks against a local next server (DB = sandy_test_local).
 * Env: BASE_URL, SANDY_TEST_DB_PASSWORD, and optional SESSION cookies created here.
 *
 * ADMIN-DASH-01: 401 / 403 / 200 / 400 matrix.
 * ADMIN-DASH-02: extras keys on 200, low-stock threshold write via POST /api/site-content.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4320";
const LOW_STOCK_KEY = "admin_low_stock_threshold";
const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
});

function hashSessionToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

async function ensureSessions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token_hash CHAR(64) NOT NULL,
      staff_id INT NULL,
      is_master TINYINT(1) NOT NULL DEFAULT 0,
      role VARCHAR(32) NOT NULL,
      name VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_sessions_token_hash (token_hash)
    )
  `);
}

async function mint(role) {
  const raw = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(raw);
  const expires = new Date(Date.now() + 7 * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at)
     VALUES (?,?,?,?,?,?)`,
    [tokenHash, null, role === "super_admin" ? 1 : 0, role, `dash-${role}`, expires]
  );
  return raw;
}

async function hit(path, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = `sAdminSession=${cookie}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Same-origin JSON POST (requireAdmin enforces Origin/Referer provenance on unsafe methods). */
async function postJson(path, body, cookie) {
  const headers = { "Content-Type": "application/json", Origin: BASE, Referer: `${BASE}/admin` };
  if (cookie) headers.Cookie = `sAdminSession=${cookie}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

const EXTRA_KEYS = [
  "revenue_trend",
  "top_products",
  "low_stock",
  "cancel_reasons",
  "payment_methods",
  "oldest_pending",
  "coupon_usage",
];
const LEGACY_KEYS = [
  "success",
  "range",
  "total_orders",
  "pending_orders",
  "pending_value",
  "confirmed_sales",
  "revenue",
  "tax_collected",
  "cancelled_orders",
  "cancelled_value",
  "customer_count",
  "product_count",
  "delivered_orders",
  "vat_null_orders",
];

let checks = 0;
const eq = (a, b, m) => {
  assert.deepStrictEqual(a, b, m);
  checks++;
};
const ok = (v, m) => {
  assert.ok(v, m);
  checks++;
};

/** Shape assertions for a 200 dashboard summary body. */
function assertSummaryShape(json, label, expectedBucket) {
  ok(json && json.success === true, `${label}: success`);
  for (const k of LEGACY_KEYS) ok(k in json, `${label}: legacy key ${k}`);
  for (const k of EXTRA_KEYS) ok(k in json, `${label}: extras key ${k}`);

  const t = json.revenue_trend;
  ok(t && (t.bucket === "day" || t.bucket === "month"), `${label}: trend.bucket`);
  if (expectedBucket) eq(t.bucket, expectedBucket, `${label}: trend bucket for preset`);
  ok(Array.isArray(t.points) && t.points.length <= 90, `${label}: trend points array capped at 90`);
  for (const p of t.points) {
    ok(typeof p.key === "string" && typeof p.label === "string", `${label}: trend point key/label`);
    ok(Number.isFinite(p.incl) && Number.isFinite(p.excl), `${label}: trend point numbers`);
  }

  ok(Array.isArray(json.top_products?.by_units) && json.top_products.by_units.length <= 5, `${label}: top by_units`);
  ok(Array.isArray(json.top_products?.by_revenue) && json.top_products.by_revenue.length <= 5, `${label}: top by_revenue`);
  for (const r of [...json.top_products.by_units, ...json.top_products.by_revenue]) {
    ok(typeof r.name === "string" && Number.isFinite(r.units) && Number.isFinite(r.revenue), `${label}: top row shape`);
  }

  const ls = json.low_stock;
  ok(Number.isInteger(ls?.threshold) && ls.threshold >= 0 && ls.threshold <= 9999, `${label}: low_stock.threshold int`);
  ok(Number.isInteger(ls?.count) && ls.count >= 0, `${label}: low_stock.count`);
  ok(Array.isArray(ls?.products) && ls.products.length <= 10, `${label}: low_stock.products <= 10`);
  for (const p of ls.products) {
    ok(Number.isFinite(p.id) && typeof p.name === "string" && Number.isFinite(p.stock_quantity), `${label}: low_stock row`);
    ok(p.stock_quantity <= ls.threshold, `${label}: low_stock row within threshold`);
  }

  ok(Array.isArray(json.cancel_reasons) && json.cancel_reasons.length <= 5, `${label}: cancel_reasons <= 5`);
  for (const r of json.cancel_reasons) ok(typeof r.reason === "string" && Number.isFinite(r.count), `${label}: cancel row`);

  ok(Array.isArray(json.payment_methods), `${label}: payment_methods array`);
  for (const r of json.payment_methods) {
    ok(typeof r.method === "string" && Number.isFinite(r.count) && Number.isFinite(r.total), `${label}: payment row`);
  }

  ok(Array.isArray(json.oldest_pending) && json.oldest_pending.length <= 5, `${label}: oldest_pending <= 5`);
  for (const r of json.oldest_pending) {
    ok(
      typeof r.order_id === "string" &&
        Number.isFinite(r.age_hours) &&
        typeof r.age_label === "string" &&
        Number.isFinite(r.total) &&
        typeof r.created_at === "string",
      `${label}: oldest_pending row`
    );
  }

  ok(Array.isArray(json.coupon_usage), `${label}: coupon_usage array`);
  for (const r of json.coupon_usage) {
    ok(typeof r.code === "string" && Number.isFinite(r.orders) && Number.isFinite(r.discount_total), `${label}: coupon row`);
    eq(r.code, r.code.toUpperCase(), `${label}: coupon codes are upper-cased`);
  }
}

async function main() {
  await ensureSessions();
  const writer = await mint("writer");
  const manager = await mint("manager");
  const superAdmin = await mint("super_admin");

  // ---- ADMIN-DASH-01: access matrix ----
  const unauth = await hit("/api/admin-dashboard-summary?preset=all");
  eq(unauth.status, 401, `unauth expected 401 got ${unauth.status} ${unauth.text}`);
  ok(!EXTRA_KEYS.some((k) => unauth.json && k in unauth.json), "401 body leaks no extras");

  const w = await hit("/api/admin-dashboard-summary?preset=all", writer);
  eq(w.status, 403, `writer expected 403 got ${w.status} ${w.text}`);
  ok(!EXTRA_KEYS.some((k) => w.json && k in w.json), "403 body leaks no extras");

  const m = await hit("/api/admin-dashboard-summary?preset=all", manager);
  eq(m.status, 200, `manager expected 200 got ${m.status} ${m.text}`);
  eq(m.json?.success, true);
  ok(/private/.test(m.headers.get("cache-control") || "") && /no-store/.test(m.headers.get("cache-control") || ""), "Cache-Control private, no-store");

  const s = await hit("/api/admin-dashboard-summary?preset=all", superAdmin);
  eq(s.status, 200);
  eq(s.json?.success, true);

  const badPreset = await hit("/api/admin-dashboard-summary?preset=nope", manager);
  eq(badPreset.status, 400);

  const badCustom = await hit("/api/admin-dashboard-summary?preset=custom&from=bad&to=2026-01-01", manager);
  eq(badCustom.status, 400);

  const badOrder = await hit("/api/admin-dashboard-summary?preset=custom&from=2026-12-01&to=2026-01-01", manager);
  eq(badOrder.status, 400);

  // ---- ADMIN-DASH-02: extras on every 200 ----
  assertSummaryShape(m.json, "manager/all", "month");
  assertSummaryShape(s.json, "super_admin/all", "month");
  const presets = ["today", "7d", "30d", "this_month"];
  for (const p of presets) {
    const r = await hit(`/api/admin-dashboard-summary?preset=${p}`, manager);
    eq(r.status, 200, `${p}: ${r.text}`);
    assertSummaryShape(r.json, `manager/${p}`, "day");
  }
  const custom = await hit("/api/admin-dashboard-summary?preset=custom&from=2026-10-01&to=2026-11-12", superAdmin);
  eq(custom.status, 200, custom.text);
  assertSummaryShape(custom.json, "super_admin/custom", "day");

  // ---- threshold write via POST /api/site-content ----
  const [prevRows] = await pool
    .query("SELECT content_value FROM site_content WHERE content_key = ?", [LOW_STOCK_KEY])
    .catch(() => [[]]);
  const prevValue = prevRows[0] ? prevRows[0].content_value : null;

  const postStatuses = {};
  try {
    // unauthenticated write is rejected
    const noAuthPost = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: "9" }, null);
    eq(noAuthPost.status, 401, `unauth threshold write: ${noAuthPost.text}`);
    postStatuses.unauth = noAuthPost.status;

    // valid integer (number and numeric string)
    const okNum = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: 12 }, manager);
    eq(okNum.status, 200, `manager valid int write: ${okNum.text}`);
    eq(okNum.json?.success, true);
    let read = await hit("/api/admin-dashboard-summary?preset=all", manager);
    eq(read.status, 200);
    eq(read.json.low_stock.threshold, 12, "dashboard reflects the stored threshold");
    const [rowA] = await pool.query("SELECT content_value FROM site_content WHERE content_key = ?", [LOW_STOCK_KEY]);
    eq(String(rowA[0].content_value), "12", "persisted as canonical string");

    const okStr = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: " 7 " }, manager);
    eq(okStr.status, 200, `manager valid string write: ${okStr.text}`);
    read = await hit("/api/admin-dashboard-summary?preset=all", superAdmin);
    eq(read.json.low_stock.threshold, 7, "trimmed string stored as 7");
    const [rowB] = await pool.query("SELECT content_value FROM site_content WHERE content_key = ?", [LOW_STOCK_KEY]);
    eq(String(rowB[0].content_value), "7");

    const okZero = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: "0" }, manager);
    eq(okZero.status, 200, "0 is allowed");
    const okMax = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: "9999" }, superAdmin);
    eq(okMax.status, 200, "9999 is allowed");
    postStatuses.valid = [okNum.status, okStr.status, okZero.status, okMax.status];

    // `updates[]` array form goes through the same validator
    const okBatch = await postJson("/api/site-content", { updates: [{ key: LOW_STOCK_KEY, value: "6" }] }, manager);
    eq(okBatch.status, 200, `updates[] valid: ${okBatch.text}`);

    // invalid values -> 400, and the stored value is untouched
    await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: "6" }, manager);
    const invalid = ["", "   ", "abc", "-1", "1.5", "10000", "1e2", "0x10", "5abc", "+5", null, -1, 1.5, 10000, true];
    const invalidStatuses = [];
    for (const v of invalid) {
      const r = await postJson("/api/site-content", { key: LOW_STOCK_KEY, value: v }, manager);
      eq(r.status, 400, `invalid ${JSON.stringify(v)} expected 400 got ${r.status} ${r.text}`);
      ok(typeof r.json?.error === "string" && r.json.error.length > 0, "400 carries an error message");
      invalidStatuses.push(r.status);
    }
    const badBatch = await postJson(
      "/api/site-content",
      { updates: [{ key: "site_title", value: "should not be written" }, { key: LOW_STOCK_KEY, value: "nope" }] },
      manager
    );
    eq(badBatch.status, 400, `updates[] invalid: ${badBatch.text}`);
    const [rowC] = await pool.query("SELECT content_value FROM site_content WHERE content_key = ?", [LOW_STOCK_KEY]);
    eq(String(rowC[0].content_value), "6", "invalid writes did not change the stored threshold");
    const [titleRows] = await pool.query("SELECT content_value FROM site_content WHERE content_key = 'site_title'");
    ok(!titleRows[0] || titleRows[0].content_value !== "should not be written", "batch with an invalid row is all-or-nothing");
    postStatuses.invalid = [...new Set(invalidStatuses)];

    // PUT path uses the same validator
    const putBad = await fetch(`${BASE}/api/site-content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: BASE, Referer: `${BASE}/admin`, Cookie: `sAdminSession=${manager}` },
      body: JSON.stringify({ content_key: LOW_STOCK_KEY, content_value: "abc" }),
    });
    eq(putBad.status, 400, "PUT with invalid threshold -> 400");

    // writers are still blocked from the dashboard regardless of threshold writes
    const w2 = await hit("/api/admin-dashboard-summary?preset=all", writer);
    eq(w2.status, 403);
  } finally {
    // restore whatever was there before
    if (prevValue === null) {
      await pool.query("DELETE FROM site_content WHERE content_key = ?", [LOW_STOCK_KEY]).catch(() => {});
    } else {
      await pool
        .query("UPDATE site_content SET content_value = ? WHERE content_key = ?", [prevValue, LOW_STOCK_KEY])
        .catch(() => {});
    }
  }

  console.log("DASHBOARD_AUTH_HTTP_PASS", {
    checks,
    unauth: unauth.status,
    writer: w.status,
    manager: m.status,
    super_admin: s.status,
    badPreset: badPreset.status,
    threshold_posts: postStatuses,
    totals: { total_orders: s.json?.total_orders, revenue: s.json?.revenue },
  });

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
