/**
 * ADMIN-SEARCH-01 — HTTP auth/validation/role checks for GET /api/admin-search against a local
 * next server (DB = sandy_test_local). Pattern follows tests/admin-orders-auth-http.mjs.
 *
 * Env: BASE_URL (default http://127.0.0.1:4331), SANDY_TEST_DB_PASSWORD,
 *      RUN_RATE_LIMIT=1 (optional; sends ~70 requests and expects 429 + Retry-After — run it last,
 *      it exhausts the per-IP search budget for ~1 minute)
 * Run: node tests/admin-search-auth-http.mjs
 *
 * Mints writer / manager / super_admin sessions into admin_sessions (names prefixed `as1-auth-`) and seeds
 * a few rows (order_id `AS1H-*`, blog/FAQ titles `AS1H `). Only those rows are removed afterwards.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:4331").replace(/\/+$/, "");
const NAME_PREFIX = "as1-auth-";

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
  charset: "utf8mb4",
});

const hashSessionToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

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
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at)
     VALUES (?,?,?,?,?,?)`,
    [hashSessionToken(raw), null, role === "super_admin" ? 1 : 0, role, `${NAME_PREFIX}${role}`, expires]
  );
  return raw;
}

async function ensureOptionalOrderCols() {
  for (const [col, ddl] of [
    ["receipt_path", "ALTER TABLE orders ADD COLUMN receipt_path VARCHAR(500) NULL"],
    ["payment_reference", "ALTER TABLE orders ADD COLUMN payment_reference VARCHAR(255) NULL"],
  ]) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?`,
      [col]
    );
    if (Number(rows?.[0]?.c || 0) === 0) {
      await pool.query(ddl);
    }
  }
}

async function seed() {
  // Additive only (no-ops when the real tables already exist).
  await ensureOptionalOrderCols();
  await pool.query(`CREATE TABLE IF NOT EXISTS blog_posts (
    id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(500) NOT NULL, slug VARCHAR(500), status VARCHAR(20) DEFAULT 'published')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faqs (
    id INT AUTO_INCREMENT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL)`);
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, total, status, payment_method,
                         receipt_path, payment_reference, created_at)
     VALUES ('AS1H-0001','Harriet Searchable','harriet@as1h.test','+923009990001',250,'pending','bank',
             '/uploads/receipts/AS1HSECRETRECEIPT.png','AS1HSECRETREF','2026-06-01 12:00:00')`
  );
  await pool.query("INSERT INTO blog_posts (title, slug, status) VALUES ('AS1H Searchable Blog','as1h-searchable-blog','published')");
  await pool.query("INSERT INTO faqs (question, answer) VALUES ('AS1H Searchable FAQ?','answer')");
}

async function cleanup() {
  await pool.query("DELETE FROM admin_sessions WHERE name LIKE ?", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'AS1H-%'");
  await pool.query("DELETE FROM blog_posts WHERE title LIKE 'AS1H %'");
  await pool.query("DELETE FROM faqs WHERE question LIKE 'AS1H %'");
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
    /* not JSON */
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

const S = (q) => `/api/admin-search?q=${encodeURIComponent(q)}`;
const noStore = (r) => {
  const cc = String(r.headers.get("cache-control") || "");
  assert.match(cc, /private/i);
  assert.match(cc, /no-store/i);
};

async function main() {
  await ensureSessions();
  await cleanup();
  await seed();
  const writer = await mint("writer");
  const manager = await mint("manager");
  const superAdmin = await mint("super_admin");

  // ---- no cookie -> 401 (before validation)
  expectStatus("unauth.search", await hit(S("AS1H-0001")), 401);
  expectStatus("unauth.bogus_cookie", await hit(S("AS1H-0001"), "deadbeef".repeat(8)), 401);
  expectStatus("unauth.bad_q_is_401", await hit("/api/admin-search?q=a"), 401);
  expectStatus("unauth.missing_q_is_401", await hit("/api/admin-search"), 401);

  // ---- wrong method
  expectStatus("post.405", await hit(S("AS1H-0001"), manager, { method: "POST" }), 405);

  // ---- invalid q -> 400 (authenticated)
  const bad = {
    missing: "/api/admin-search",
    empty: "/api/admin-search?q=",
    one_char: S("a"),
    whitespace_only: S("   "),
    too_long: S("x".repeat(81)),
    array: "/api/admin-search?q=ab&q=cd",
  };
  for (const role of [["manager", manager], ["writer", writer]]) {
    for (const [label, url] of Object.entries(bad)) {
      expectStatus(`400.${role[0]}.${label}`, await hit(url, role[1]), 400, (r) => {
        assert.equal(typeof r.json?.error, "string");
        noStore(r);
      });
    }
  }
  expectStatus("200.min_len_2", await hit(S("ab"), manager), 200);
  expectStatus("200.max_len_80", await hit(S("x".repeat(80)), manager), 200);

  // ---- manager and super_admin: orders + customers + products + blog + faqs
  for (const [label, cookie] of [["manager", manager], ["super_admin", superAdmin]]) {
    expectStatus(`${label}.orders`, await hit(S("AS1H-0001"), cookie), 200, (r) => {
      assert.equal(r.json?.success, true);
      assert.equal(r.json?.q, "AS1H-0001");
      noStore(r);
      const g = r.json?.groups;
      assert.ok(g && typeof g === "object", "groups object");
      for (const k of ["orders", "customers", "products", "blog", "faqs"]) {
        assert.ok(Array.isArray(g[k]), `${label} has ${k} array`);
        assert.ok(g[k].length <= 5, `${k} limited to 5`);
      }
      assert.deepEqual(g.orders.map((o) => o.order_id), ["AS1H-0001"]);
      assert.equal(g.orders[0].customer_email, "harriet@as1h.test");
      assert.ok(!/SECRET/.test(r.text), "no receipt/payment secrets in payload");
      assert.ok(!/receipt_path|payment_reference/.test(r.text), "no secret field names in payload");
    });
    expectStatus(`${label}.customers`, await hit(S("Harriet"), cookie), 200, (r) => {
      assert.deepEqual(r.json.groups.customers.map((c) => c.customer_email), ["harriet@as1h.test"]);
      assert.equal(r.json.groups.customers[0].order_count, 1);
    });
    expectStatus(`${label}.blog_faq`, await hit(S("AS1H Searchable"), cookie), 200, (r) => {
      assert.deepEqual(r.json.groups.blog.map((b) => b.title), ["AS1H Searchable Blog"]);
      assert.deepEqual(r.json.groups.faqs.map((f) => f.question), ["AS1H Searchable FAQ?"]);
    });
  }

  // ---- writer: 200 but filtered server-side to blog + faqs only
  expectStatus("writer.order_query_filtered", await hit(S("AS1H-0001"), writer), 200, (r) => {
    assert.equal(r.json?.success, true);
    noStore(r);
    const g = r.json.groups;
    assert.equal(g.orders, undefined, "writer has no orders group");
    assert.equal(g.customers, undefined, "writer has no customers group");
    assert.equal(g.products, undefined, "writer has no products group");
    assert.deepEqual(Object.keys(g).sort(), ["blog", "faqs"]);
    // Exclude echoed query string from the leak check (q is expected to repeat the search term).
    const bodySansQ = r.text.replace(/"q"\s*:\s*"[^"]*"/, '"q":""');
    assert.ok(!/harriet|AS1H-0001|SECRET/i.test(bodySansQ), "writer payload leaks no order data");
  });
  expectStatus("writer.customer_query_filtered", await hit(S("Harriet"), writer), 200, (r) => {
    assert.ok(!/harriet/i.test(r.text.replace(/"q":"Harriet"/, "")), "writer sees no customer data");
    assert.equal(r.json.groups.customers, undefined);
  });
  expectStatus("writer.blog_faq", await hit(S("AS1H Searchable"), writer), 200, (r) => {
    assert.deepEqual(r.json.groups.blog.map((b) => b.title), ["AS1H Searchable Blog"]);
    assert.deepEqual(r.json.groups.faqs.map((f) => f.question), ["AS1H Searchable FAQ?"]);
  });

  // ---- wildcard characters are literal over HTTP too
  expectStatus("manager.wildcard_pct", await hit(S("%%"), manager), 200, (r) => {
    assert.deepEqual(r.json.groups.orders, []);
  });
  expectStatus("manager.wildcard_underscore", await hit(S("__"), manager), 200, (r) => {
    assert.deepEqual(r.json.groups.orders, []);
  });

  // ---- optional: rate limit (RL_SEARCH = 60 / minute / IP)
  if (process.env.RUN_RATE_LIMIT === "1") {
    let limited = null;
    for (let i = 0; i < 80 && !limited; i += 1) {
      const r = await hit(S("ratelimit"), manager);
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, "429 reached within 80 requests");
    assertions += 1;
    assert.ok(Number(limited.headers.get("retry-after")) > 0, "Retry-After header set");
    assertions += 1;
    results["429.rate_limit"] = 429;
  }

  console.log("AS1_AUTH_HTTP_PASS", JSON.stringify({ base: BASE, assertions, results }));
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error("AS1_AUTH_HTTP_FAIL", e);
} finally {
  try {
    await cleanup();
  } catch (e) {
    console.error("AS1_AUTH_HTTP_CLEANUP_FAIL", e && e.message);
  }
  await pool.end();
}
process.exit(failed ? 1 : 0);
