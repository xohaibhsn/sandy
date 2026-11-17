/**
 * Phase 2 P3b — RBAC integration with real rows: role decisions made by the HTTP endpoints are verified
 * against the database afterwards (mutation happened / did NOT happen).
 *
 *   manager: order status change OK, cancel with reason OK, order DELETE 403 (row still there)
 *   SA:      order DELETE 200 (rows gone)
 *   writer:  product write 403 (no row created / changed / deleted), no catalogue/coupon/order reads
 *   manager: tax 403 (GET/POST/PUT, no row created), staff 403 (read + write), SA-only site keys 403
 *   SA:      staff create/delete OK, tax read OK
 *   writer:  blog + FAQ CRUD OK; writer search sees blog+FAQs only; manager search also sees orders
 *
 * Needs a running local next server (DB = sandy_test_local on 127.0.0.1:3307).
 * Env: BASE_URL (default http://127.0.0.1:4330), SANDY_TEST_DB_PASSWORD
 * Run: node tests/admin-rbac-db.test.mjs
 *
 * Seeds are prefixed `RBAC-DB` / `rbac-db-` and ONLY those rows are removed. Existing values that a test
 * temporarily changes (site_content) are restored from a snapshot.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:4330").replace(/\/+$/, "");
const PFX = "RBAC-DB";
const SESSION_PREFIX = "rbac-db-";

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

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

async function mint(role) {
  const raw = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)`,
    [sha(raw), null, role === "super_admin" ? 1 : 0, role, `${SESSION_PREFIX}${role}`, expires]
  );
  return raw;
}

async function call(cookie, method, url, body) {
  const headers = {};
  if (cookie) headers.Cookie = `sAdminSession=${cookie}`;
  if (method !== "GET") headers.Origin = BASE;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

let assertions = 0;
const names = [];
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};
async function scenario(name, fn) {
  try {
    await fn();
    names.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}
const one = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows[0] : undefined;
};
const count = async (sql, params = []) => Number((await one(sql, params))?.c || 0);

const GENERIC = { error: "Forbidden" };
function forbidden(r, label) {
  eq(r.status, 403, `${label}: ${r.status} ${r.text.slice(0, 120)}`);
  eq(r.json, GENERIC, `${label}: generic body`);
}

const snapshots = new Map(); // site_content restore

async function cleanup() {
  try {
    await pool.query("DELETE FROM order_items WHERE order_id LIKE ?", [`${PFX}-%`]);
    await pool.query("DELETE FROM orders WHERE order_id LIKE ?", [`${PFX}-%`]);
    await pool.query("DELETE FROM products WHERE name LIKE ?", [`${PFX}%`]);
    await pool.query("DELETE FROM coupons WHERE code LIKE ?", [`${PFX}%`]);
    await pool.query("DELETE FROM admin_staff WHERE email LIKE ?", ["rbac-db-%"]);
    await pool.query("DELETE FROM faqs WHERE question LIKE ?", [`${PFX}%`]).catch(() => {});
    await pool.query("DELETE FROM blog_posts WHERE title LIKE ?", [`${PFX}%`]).catch(() => {});
    await pool.query("DELETE FROM tax_classes WHERE name LIKE ?", [`${PFX}%`]).catch(() => {});
    for (const [key, value] of snapshots) {
      if (value === null) await pool.query("DELETE FROM site_content WHERE content_key = ?", [key]);
      else await pool.query("UPDATE site_content SET content_value = ? WHERE content_key = ?", [value, key]);
    }
    await pool.query("DELETE FROM admin_sessions WHERE name LIKE ?", [`${SESSION_PREFIX}%`]);
  } catch (e) {
    console.error("cleanup warning", e?.message || e);
  }
}

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY, token_hash CHAR(64) NOT NULL, staff_id INT NULL,
      is_master TINYINT(1) NOT NULL DEFAULT 0, role VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_sessions_token_hash (token_hash))`);
  const W = await mint("writer");
  const M = await mint("manager");
  const S = await mint("super_admin");

  // Make sure shop tables exist (endpoint bootstraps them), then the local-only cancel column.
  eq((await call(S, "GET", "/api/admin-orders?page=1&pageSize=10")).status, 200, "bootstrap orders");
  eq((await call(S, "GET", "/api/admin-products")).status, 200, "bootstrap products");
  const dbName = (await one("SELECT DATABASE() AS d")).d;
  eq(dbName, "sandy_test_local", "refuse to run against anything but the local test DB");
  const col = await one("SHOW COLUMNS FROM orders LIKE 'cancel_reason'");
  if (!col) await pool.query("ALTER TABLE orders ADD COLUMN cancel_reason VARCHAR(500) NULL"); // local test DB only

  const mkOrder = async (id, status = "pending") => {
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, total, vat_amount, discount_amount, status, payment_method, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
      [id, `${PFX} RBACDBZZ Customer`, "rbac-db-customer@example.test", "0300000000", 1000, 0, 0, status, "cod"]
    );
    await pool.query(
      "INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?,?,?,?,?)",
      [id, null, `${PFX} item`, 1000, 1]
    );
  };
  const orderStatus = async (id) => (await one("SELECT status FROM orders WHERE order_id=?", [id]))?.status;

  await scenario("manager: status change + cancel with reason; delete is 403; SA delete works", async () => {
    const A = `${PFX}-ORD-A`;
    const B = `${PFX}-ORD-B`;
    await mkOrder(A);
    await mkOrder(B);

    // status change
    let r = await call(M, "PATCH", "/api/admin-orders", { order_id: A, status: "confirmed" });
    eq(r.status, 200, r.text);
    eq(await orderStatus(A), "confirmed");

    // cancel with reason
    r = await call(M, "PATCH", "/api/admin-orders", {
      order_id: B,
      status: "cancelled",
      cancel_reason_code: "customer_cancelled",
      cancel_reason_note: "rbac db test",
    });
    eq(r.status, 200, r.text);
    eq(await orderStatus(B), "cancelled");
    ok(String((await one("SELECT cancel_reason AS c FROM orders WHERE order_id=?", [B])).c || "").length > 0, "reason stored");

    // manager delete -> 403, rows untouched
    r = await call(M, "DELETE", "/api/admin-orders", { order_id: A });
    forbidden(r, "manager delete");
    eq(await count("SELECT COUNT(*) c FROM orders WHERE order_id=?", [A]), 1);
    eq(await count("SELECT COUNT(*) c FROM order_items WHERE order_id=?", [A]), 1);

    // writer: nothing order-related, even with a valid order id
    for (const [m, u, b] of [
      ["GET", `/api/admin-orders?id=${A}`],
      ["GET", "/api/admin-orders?page=1&pageSize=10"],
      ["GET", "/api/admin-orders-export"],
      ["PATCH", "/api/admin-orders", { order_id: A, status: "delivered" }],
      ["DELETE", "/api/admin-orders", { order_id: A }],
    ]) {
      forbidden(await call(W, m, u, b), `writer ${m} ${u}`);
    }
    eq(await orderStatus(A), "confirmed", "writer did not change status");
    eq(await count("SELECT COUNT(*) c FROM orders WHERE order_id=?", [A]), 1);

    // super_admin delete -> rows removed
    r = await call(S, "DELETE", "/api/admin-orders", { order_id: A });
    eq(r.status, 200, r.text);
    eq(await count("SELECT COUNT(*) c FROM orders WHERE order_id=?", [A]), 0);
    eq(await count("SELECT COUNT(*) c FROM order_items WHERE order_id=?", [A]), 0);

    // manager still sees order detail + export
    eq((await call(M, "GET", `/api/admin-orders?id=${B}`)).status, 200);
    eq((await call(M, "GET", "/api/admin-orders-export")).status, 200);
  });

  await scenario("writer product write is 403 and never touches the table; manager can write", async () => {
    await pool.query("INSERT INTO products (name, slug, price, category, active, track_inventory) VALUES (?,?,?,?,1,0)", [
      `${PFX} Product`,
      "rbac-db-product",
      100,
      "RBAC",
    ]);
    const p = await one("SELECT id FROM products WHERE name=?", [`${PFX} Product`]);

    forbidden(await call(W, "GET", "/api/admin-products"), "writer product list");
    forbidden(await call(W, "GET", "/api/admin-products?tax_classes=1"), "writer tax class options");
    forbidden(await call(W, "GET", "/api/categories"), "writer categories");
    forbidden(await call(W, "POST", "/api/admin-products", { name: `${PFX} Writer New`, slug: "rbac-db-writer-new", price: 1, category: "RBAC" }), "writer product create");
    eq(await count("SELECT COUNT(*) c FROM products WHERE name=?", [`${PFX} Writer New`]), 0);
    forbidden(await call(W, "PUT", "/api/admin-products", { id: p.id, name: `${PFX} Hijacked`, slug: "x", price: 1, category: "RBAC" }), "writer product update");
    eq((await one("SELECT name FROM products WHERE id=?", [p.id])).name, `${PFX} Product`);
    forbidden(await call(W, "PATCH", "/api/admin-products", { id: p.id, active: 0 }), "writer product toggle");
    eq(Number((await one("SELECT active FROM products WHERE id=?", [p.id])).active), 1);
    forbidden(await call(W, "DELETE", `/api/admin-products?id=${p.id}`), "writer product delete");
    eq(await count("SELECT COUNT(*) c FROM products WHERE id=?", [p.id]), 1);

    // manager toggles + deletes
    let r = await call(M, "PATCH", "/api/admin-products", { id: p.id, active: 0 });
    eq(r.status, 200, r.text);
    eq(Number((await one("SELECT active FROM products WHERE id=?", [p.id])).active), 0);
    ok((await call(M, "GET", "/api/admin-products")).status === 200);
    r = await call(M, "DELETE", `/api/admin-products?id=${p.id}`);
    eq(r.status, 200, r.text);
    eq(await count("SELECT COUNT(*) c FROM products WHERE id=?", [p.id]), 0);
  });

  await scenario("coupons: writer 403, manager CRUD", async () => {
    forbidden(await call(W, "GET", "/api/coupons"), "writer coupons list");
    forbidden(await call(W, "POST", "/api/coupons", { code: `${PFX}W`, type: "fixed", value: 5 }), "writer coupon create");
    eq(await count("SELECT COUNT(*) c FROM coupons WHERE code=?", [`${PFX}W`]), 0);
    let r = await call(M, "POST", "/api/coupons", { code: `${PFX}M`, type: "fixed", value: 5 });
    eq(r.status, 200, r.text);
    const id = r.json.id;
    eq((await call(M, "GET", "/api/coupons")).status, 200);
    forbidden(await call(W, "DELETE", `/api/coupons?id=${id}`), "writer coupon delete");
    eq(await count("SELECT COUNT(*) c FROM coupons WHERE id=?", [id]), 1);
    r = await call(M, "DELETE", `/api/coupons?id=${id}`);
    eq(r.status, 200, r.text);
    eq(await count("SELECT COUNT(*) c FROM coupons WHERE id=?", [id]), 0);
    // public validate stays public
    eq((await call(null, "POST", "/api/coupons?action=validate", { code: "NOPE-NOPE", cart_total: 10 })).status, 200);
  });

  await scenario("tax is super_admin only", async () => {
    forbidden(await call(M, "GET", "/api/admin-tax"), "manager tax GET");
    forbidden(await call(W, "GET", "/api/admin-tax"), "writer tax GET");
    const mk = (n) => ({ action: "create_class", name: `${PFX} ${n}`, slug: `rbac-db-${n}`, applies_to: "both" });
    forbidden(await call(M, "POST", "/api/admin-tax", mk("m")), "manager tax POST");
    forbidden(await call(M, "PUT", "/api/admin-tax", { id: 1, active: 0 }), "manager tax PUT");
    forbidden(await call(W, "POST", "/api/admin-tax", mk("w")), "writer tax POST");
    eq(await count("SELECT COUNT(*) c FROM tax_classes WHERE name LIKE ?", [`${PFX}%`]).catch(() => 0), 0);

    const get = await call(S, "GET", "/api/admin-tax");
    ok([200, 503].includes(get.status), `SA tax GET ${get.status}`);
    if (get.status === 200) {
      const r = await call(S, "POST", "/api/admin-tax", mk("sa"));
      eq(r.status, 200, r.text);
      eq(await count("SELECT COUNT(*) c FROM tax_classes WHERE name=?", [`${PFX} sa`]), 1);
    }
  });

  await scenario("staff is super_admin only (read + write)", async () => {
    forbidden(await call(M, "GET", "/api/admin-staff"), "manager staff list");
    forbidden(await call(W, "GET", "/api/admin-staff"), "writer staff list");
    const body = { name: `${PFX} staff`, email: "rbac-db-staff@example.test", password: "Rbac-Db-Staff-Pass-1!x", role: "writer" };
    forbidden(await call(M, "POST", "/api/admin-staff", body), "manager staff create");
    eq(await count("SELECT COUNT(*) c FROM admin_staff WHERE email=?", [body.email]), 0);

    let r = await call(S, "POST", "/api/admin-staff", body);
    eq(r.status, 200, r.text);
    const id = r.json.id;
    ok(id > 0);
    r = await call(S, "GET", "/api/admin-staff");
    eq(r.status, 200);
    ok(Array.isArray(r.json) && r.json.some((s) => s.id === id), "SA lists staff");

    forbidden(await call(M, "PUT", "/api/admin-staff", { id, name: "x", email: body.email, role: "super_admin", active: 1 }), "manager staff promote");
    eq((await one("SELECT role FROM admin_staff WHERE id=?", [id])).role, "writer", "role unchanged");
    forbidden(await call(M, "DELETE", `/api/admin-staff?id=${id}`), "manager staff delete");
    eq(await count("SELECT COUNT(*) c FROM admin_staff WHERE id=?", [id]), 1);
    r = await call(S, "DELETE", `/api/admin-staff?id=${id}`);
    eq(r.status, 200);
    eq(await count("SELECT COUNT(*) c FROM admin_staff WHERE id=?", [id]), 0);
  });

  await scenario("site-content: SA-only keys protected; manager+writer content keys writable", async () => {
    const snap = async (key) => {
      if (!snapshots.has(key)) snapshots.set(key, (await one("SELECT content_value v FROM site_content WHERE content_key=?", [key]))?.v ?? null);
    };
    // make sure the table/rows exist
    await call(S, "POST", "/api/site-content", { updates: [] }); // 400 but boots table
    await snap("home_tagline");
    await snap("site_title");
    await snap("contact_phone");

    const titleBefore = (await one("SELECT content_value v FROM site_content WHERE content_key='site_title'"))?.v ?? null;

    forbidden(await call(M, "POST", "/api/site-content", { updates: [{ key: "site_title", value: `${PFX} hacked` }] }), "manager branding write");
    eq((await one("SELECT content_value v FROM site_content WHERE content_key='site_title'"))?.v ?? null, titleBefore, "site_title untouched");
    forbidden(await call(W, "POST", "/api/site-content", { updates: [{ key: "site_title", value: `${PFX} writer brand` }] }), "writer branding write");

    // writer may edit non-branding content keys (D3)
    let r = await call(W, "POST", "/api/site-content", { updates: [{ key: "home_tagline", value: `${PFX} writer` }] });
    eq(r.status, 200, r.text);
    eq((await one("SELECT content_value v FROM site_content WHERE content_key='home_tagline'")).v, `${PFX} writer`);

    // manager content + contact keys (Content Editor "Save Contact" payload shape) succeed
    r = await call(M, "POST", "/api/site-content", { updates: [{ key: "home_tagline", value: `${PFX} manager tagline` }, { key: "contact_phone", value: "0300 RBAC" }] });
    eq(r.status, 200, r.text);
    eq((await one("SELECT content_value v FROM site_content WHERE content_key='home_tagline'")).v, `${PFX} manager tagline`);

    // PUT/DELETE (arbitrary keys) are SA only
    forbidden(await call(M, "PUT", "/api/site-content", { content_key: "home_tagline", content_value: "x" }), "manager PUT");
    forbidden(await call(M, "DELETE", "/api/site-content?key=home_tagline"), "manager DELETE");
    eq(await count("SELECT COUNT(*) c FROM site_content WHERE content_key='home_tagline'"), 1);

    // SA may write a branding key (idempotent: same value)
    r = await call(S, "POST", "/api/site-content", { updates: [{ key: "site_title", value: titleBefore ?? "" }] });
    eq(r.status, 200, r.text);
  });

  await scenario("writer: blog + FAQ CRUD allowed; sections writes denied", async () => {
    let r = await call(W, "POST", "/api/faqs", { question: `${PFX} faq RBACDBZZ`, answer: "a" });
    eq(r.status, 200, r.text);
    const faqId = r.json.id;
    r = await call(W, "PUT", "/api/faqs", { id: faqId, question: `${PFX} faq RBACDBZZ`, answer: "b" });
    eq(r.status, 200, r.text);

    r = await call(W, "POST", "/api/blog", { title: `${PFX} post RBACDBZZ`, slug: "rbac-db-post", content: "<p>x</p>", featured_image: "" });
    eq(r.status, 200, r.text);
    const postId = r.json.id;

    // writer search: blog + faqs only; manager also sees orders/customers
    await mkOrder(`${PFX}-ORD-S`);
    const ws = await call(W, "GET", "/api/admin-search?q=RBACDBZZ");
    eq(ws.status, 200, ws.text);
    ok(Object.keys(ws.json.groups).every((k) => k === "blog" || k === "faqs"), `writer groups ${Object.keys(ws.json.groups)}`);
    ok(ws.json.groups.faqs?.length >= 1 && ws.json.groups.blog?.length >= 1, "writer finds own blog + faq");
    const ms = await call(M, "GET", "/api/admin-search?q=RBACDBZZ");
    eq(ms.status, 200, ms.text);
    ok((ms.json.groups.orders?.length || 0) >= 1 && (ms.json.groups.customers?.length || 0) >= 1, "manager sees orders + customers");

    forbidden(await call(W, "POST", "/api/sections", { key: "home_hero", value: {} }), "writer sections write");
    forbidden(await call(W, "PUT", "/api/sections?action=visibility", { key: "home_hero", is_visible: 1 }), "writer sections visibility");
    forbidden(await call(W, "GET", "/api/admin-dashboard-summary"), "writer dashboard");
    eq((await call(M, "GET", "/api/admin-dashboard-summary")).status, 200);

    r = await call(W, "DELETE", `/api/faqs?id=${faqId}`);
    eq(r.status, 200);
    r = await call(W, "DELETE", `/api/blog?id=${postId}`);
    eq(r.status, 200);
    eq(await count("SELECT COUNT(*) c FROM faqs WHERE id=?", [faqId]), 0);
    eq(await count("SELECT COUNT(*) c FROM blog_posts WHERE id=?", [postId]), 0);
  });

  console.log("ADMIN_RBAC_DB_PASS", JSON.stringify({ base: BASE, scenarios: names, assertions }));
}

main()
  .then(async () => {
    await cleanup();
    await pool.end();
  })
  .catch(async (e) => {
    console.error("ADMIN_RBAC_DB_FAIL", e);
    await cleanup();
    await pool.end().catch(() => {});
    process.exit(1);
  });
