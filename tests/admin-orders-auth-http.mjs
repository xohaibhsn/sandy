/**
 * HTTP auth/validation checks for the admin orders endpoints against a local next server
 * (DB = sandy_test_local). Pattern follows tests/admin-dashboard-auth-http.mjs.
 *
 * Env: BASE_URL (default http://127.0.0.1:4330), SANDY_TEST_DB_PASSWORD
 * Run: node tests/admin-orders-auth-http.mjs
 *
 * Mints writer / manager / super_admin sessions straight into admin_sessions (names prefixed
 * `ao2-auth-`) and removes only those rows when finished.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:4330").replace(/\/+$/, "");
const NAME_PREFIX = "ao2-auth-";

if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}

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
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at)
     VALUES (?,?,?,?,?,?)`,
    [tokenHash, null, role === "super_admin" ? 1 : 0, role, `${NAME_PREFIX}${role}`, expires]
  );
  return raw;
}

async function hit(path, cookie, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.Cookie = `sAdminSession=${cookie}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON (e.g. CSV) */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const results = {};
let assertions = 0;
function expectStatus(label, r, status, extra) {
  assertions += 1;
  assert.equal(r.status, status, `${label}: expected ${status} got ${r.status} ${r.text.slice(0, 200)}`);
  if (extra) {
    assertions += 1;
    extra(r);
  }
  results[label] = r.status;
}

const LIST = "/api/admin-orders?page=1&pageSize=10";
const DETAIL = "/api/admin-orders?id=AO2-AUTH-NOPE";
const EXPORT = "/api/admin-orders-export";
const BADGE = "/api/admin-orders?badge=1";
const RECENT = "/api/admin-orders?recent=1";
const CUSTOMERS = "/api/admin-orders?customers=1&page=1&pageSize=10";

async function main() {
  await ensureSessions();
  const writer = await mint("writer");
  const manager = await mint("manager");
  const superAdmin = await mint("super_admin");

  // ---- no cookie -> 401
  expectStatus("unauth.list", await hit(LIST), 401);
  expectStatus("unauth.detail", await hit(DETAIL), 401);
  expectStatus("unauth.export", await hit(EXPORT), 401);
  expectStatus("unauth.badge", await hit(BADGE), 401);
  expectStatus("unauth.recent", await hit(RECENT), 401);
  expectStatus("unauth.customers", await hit(CUSTOMERS), 401);
  expectStatus("unauth.bogus_cookie", await hit(LIST, "deadbeef".repeat(8)), 401);

  // ---- writer -> 403 everywhere (Finding 7)
  expectStatus("writer.list", await hit(LIST, writer), 403);
  expectStatus("writer.detail", await hit(DETAIL, writer), 403);
  expectStatus("writer.export", await hit(EXPORT, writer), 403);
  expectStatus("writer.badge", await hit(BADGE, writer), 403);
  expectStatus("writer.recent", await hit(RECENT, writer), 403);
  expectStatus("writer.customers", await hit(CUSTOMERS, writer), 403);
  expectStatus(
    "writer.patch",
    await hit("/api/admin-orders", writer, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: "AO2-AUTH-NOPE", status: "confirmed" }),
    }),
    403
  );
  expectStatus(
    "writer.delete",
    await hit("/api/admin-orders", writer, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: "AO2-AUTH-NOPE" }),
    }),
    403
  );

  // ---- manager and super_admin -> 200
  for (const [label, cookie] of [
    ["manager", manager],
    ["super_admin", superAdmin],
  ]) {
    expectStatus(`${label}.list`, await hit(LIST, cookie), 200, (r) => {
      assert.equal(r.json?.success, true, `${label}.list success flag`);
      assert.ok(Array.isArray(r.json?.orders), `${label}.list orders array`);
      assert.equal(typeof r.json?.total, "number");
      assert.equal(r.json?.page, 1);
      assert.equal(r.json?.pageSize, 10);
      assert.ok(r.json?.totalPages >= 1);
      assert.ok(r.json?.status_counts && typeof r.json.status_counts === "object");
      assert.ok(r.json.orders.length <= 10, "list honours pageSize");
      assert.match(String(r.headers.get("cache-control") || ""), /no-store/i);
    });
    expectStatus(`${label}.badge`, await hit(BADGE, cookie), 200, (r) => {
      assert.equal(r.json?.success, true);
      assert.equal(typeof r.json?.pending_count, "number");
    });
    expectStatus(`${label}.recent`, await hit(RECENT, cookie), 200, (r) => {
      assert.equal(r.json?.success, true);
      assert.ok(Array.isArray(r.json?.orders));
      assert.ok(r.json.orders.length <= 5, "recent defaults to 5");
    });
    expectStatus(`${label}.customers`, await hit(CUSTOMERS, cookie), 200, (r) => {
      assert.equal(r.json?.success, true);
      assert.ok(Array.isArray(r.json?.customers));
      assert.equal(r.json?.pageSize, 10);
    });
    expectStatus(`${label}.export`, await hit(EXPORT, cookie), 200, (r) => {
      assert.match(String(r.headers.get("content-type") || ""), /text\/csv/i);
      assert.ok(r.text.replace(/^\uFEFF/, "").includes("order_id,created_at_pkt"), "export has CSV header");
    });
    // Unknown id is a clean 404 for permitted roles (not 403/500).
    expectStatus(`${label}.detail_missing`, await hit(DETAIL, cookie), 404);
  }

  // ---- invalid params -> 400 (manager)
  const bad = {
    bad_status: "/api/admin-orders?status=bogus",
    bad_pageSize: "/api/admin-orders?pageSize=7",
    q_len_1: "/api/admin-orders?q=a",
    bad_payment: "/api/admin-orders?payment_method=cash",
    bad_date_pair: "/api/admin-orders?from=2026-01-01",
    bad_date_order: "/api/admin-orders?from=2026-02-01&to=2026-01-01",
  };
  for (const [label, url] of Object.entries(bad)) {
    expectStatus(`400.list.${label}`, await hit(url, manager), 400, (r) => {
      assert.equal(typeof r.json?.error, "string");
    });
  }
  expectStatus("400.export.bad_status", await hit(`${EXPORT}?status=bogus`, manager), 400);
  expectStatus("400.export.q_len_1", await hit(`${EXPORT}?q=a`, manager), 400);
  expectStatus("400.export.bad_payment", await hit(`${EXPORT}?payment_method=cash`, manager), 400);
  expectStatus("400.customers.bad_pageSize", await hit("/api/admin-orders?customers=1&pageSize=7", manager), 400);
  expectStatus("400.customers.q_len_1", await hit("/api/admin-orders?customers=1&q=a", manager), 400);
  // Auth is evaluated before validation: invalid params without a cookie are still 401, writer still 403.
  expectStatus("401.before_400", await hit("/api/admin-orders?status=bogus"), 401);
  expectStatus("403.before_400", await hit("/api/admin-orders?status=bogus", writer), 403);

  console.log("AO2_AUTH_HTTP_PASS", JSON.stringify({ base: BASE, assertions, results }));
}

main()
  .then(async () => {
    await pool.query("DELETE FROM admin_sessions WHERE name LIKE ?", [`${NAME_PREFIX}%`]);
    await pool.end();
  })
  .catch(async (e) => {
    console.error("AO2_AUTH_HTTP_FAIL", e);
    try {
      await pool.query("DELETE FROM admin_sessions WHERE name LIKE ?", [`${NAME_PREFIX}%`]);
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
