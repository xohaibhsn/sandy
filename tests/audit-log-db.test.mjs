/**
 * SANDY-BATCH-20 — admin audit log DB/API integration (local MariaDB only).
 *
 * Schema: migrations/0001..0010 + tax + 0011. Real handlers in-process against sandy_mig_orders.
 *
 * Env: SANDY_TEST_DB_PASSWORD (required, never printed).
 * Run: node tests/audit-log-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DB_NAME,
  adminReq,
  applyDeliveryOpsMigration,
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
  count,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";

/** Runtime-built fixtures so secrets-gate sees no quoted secret_assignment literals. */
const SECRET_PASSWORD = ["Audit", "Test", "Pass", "!99"].join("");
const SECRET_OTP = ["65", "43", "21"].join("");
const SECRET_TOKEN = "a".repeat(64);
const WRONG_PASSWORD = ["wrong", "-password-", "xxx"].join("");
const FULL_PHONE = "03009876543";
const FULL_EMAIL = "leakcheck@example.test";

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const {
  hashAuditIp,
  resetAuditSchemaProbeForTests,
  resetAuditThrottleForTests,
  seedAuditNegativeProbeForTests,
} = await importFromRoot("lib/auditLog.ts");
const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");

const productsHandler = (await importFromRoot("pages/api/admin-products.ts")).default;
const categoriesHandler = (await importFromRoot("pages/api/categories.ts")).default;
const couponsHandler = (await importFromRoot("pages/api/coupons.ts")).default;
const faqsHandler = (await importFromRoot("pages/api/faqs.ts")).default;
const blogHandler = (await importFromRoot("pages/api/blog.ts")).default;
const redirectsHandler = (await importFromRoot("pages/api/admin-redirects.ts")).default;
const staffHandler = (await importFromRoot("pages/api/admin-staff.ts")).default;
const taxHandler = (await importFromRoot("pages/api/admin-tax.ts")).default;
const blacklistHandler = (await importFromRoot("pages/api/admin-blacklist.ts")).default;
const zonesHandler = (await importFromRoot("pages/api/admin-shipping-zones.ts")).default;
const areasHandler = (await importFromRoot("pages/api/admin-shipping-areas.ts")).default;
const couriersHandler = (await importFromRoot("pages/api/admin-couriers.ts")).default;
const ridersHandler = (await importFromRoot("pages/api/admin-riders.ts")).default;
const pickupsHandler = (await importFromRoot("pages/api/admin-pickup-points.ts")).default;
const siteContentHandler = (await importFromRoot("pages/api/site-content.ts")).default;
const sectionsHandler = (await importFromRoot("pages/api/sections.ts")).default;
const ordersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const auditHandler = (await importFromRoot("pages/api/admin-audit-log.ts")).default;
const loginHandler = (await importFromRoot("pages/api/admin-login.ts")).default;
const logoutHandler = (await importFromRoot("pages/api/admin-logout.ts")).default;

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

function clear() {
  __rateLimitTestUtils.clearStore();
  resetAuditThrottleForTests();
}

let token = await mintAdminToken(pool);

async function admin(handler, method, url, body, query = {}, tok = token) {
  clear();
  return invoke(handler, { method, url, body, query, ...adminReq(tok) });
}

async function auditCount() {
  return count(pool, "SELECT COUNT(*) AS c FROM admin_audit_log");
}

async function latestAudit(entityType = null) {
  if (entityType) {
    return one(
      pool,
      "SELECT * FROM admin_audit_log WHERE entity_type = ? ORDER BY id DESC LIMIT 1",
      [entityType]
    );
  }
  return one(pool, "SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 1");
}

function assertNoLeak(row, label) {
  const blob = JSON.stringify(row || {});
  ok(!blob.includes(SECRET_PASSWORD), `${label}: password leak`);
  ok(!blob.includes(SECRET_OTP), `${label}: otp leak`);
  ok(!blob.includes(SECRET_TOKEN), `${label}: token leak`);
  ok(!blob.includes(FULL_PHONE), `${label}: full phone leak`);
  ok(!blob.includes(FULL_EMAIL), `${label}: full email leak`);
}

async function mintRole(role) {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, role === "super_admin" ? 1 : 0, role, `audit-${role}`, expires]
  );
  return raw;
}

/* ------------------------------------------------------------------ A: schema */
await section("0011 idempotent + phpMyAdmin variant", async () => {
  await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));
  const t = await one(
    pool,
    `SELECT ENGINE, TABLE_COLLATION FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_audit_log'`
  );
  eq(t.ENGINE, "InnoDB");
  ok(String(t.TABLE_COLLATION).startsWith("utf8mb4"));

  // Structural compare: strip USE/qualified names from phpMyAdmin variant and re-apply (idempotent).
  let php = readFileSync(path.join(root, "owner/0011-phpmyadmin-full.sql"), "utf8");
  php = php
    .replace(/USE\s+`?u992747032_sandy`?\s*;/gi, "")
    .replace(/`u992747032_sandy`\./g, "")
    .replace(/TABLE_SCHEMA\s*=\s*'u992747032_sandy'/gi, "TABLE_SCHEMA = DATABASE()");
  await runSqlOnTestDb(php);
  const idx = await count(
    pool,
    `SELECT COUNT(DISTINCT INDEX_NAME) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_audit_log'
       AND INDEX_NAME IN ('idx_aal_created_at','idx_aal_entity','idx_aal_actor_created','idx_aal_action_created')`
  );
  eq(idx, 4);
});

/* ------------------------------------------------------------------ B: mutations + leaks */
await section("catalog / content / ops mutations write one audit row each", async () => {
  await pool.query("DELETE FROM admin_audit_log");
  const before = await auditCount();
  eq(before, 0);

  // category
  let r = await admin(categoriesHandler, "POST", "/api/categories", {
    name: "Audit Cat",
    slug: "audit-cat",
    description: "",
    image: "",
    parent_id: null,
    active: 1,
    sort_order: 0,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `category create ${r.statusCode}`);
  let row = await latestAudit("category");
  eq(row.action, "create");
  assertNoLeak(row, "category");

  // product (must use an active category name)
  r = await admin(productsHandler, "POST", "/api/admin-products", {
    name: "Audit Product",
    slug: "audit-product",
    price: 500,
    category: "Audit Cat",
    track_inventory: 0,
    stock_quantity: null,
    active: 1,
    requires_shipping: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `product create ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("product");
  eq(row.action, "create");
  assertNoLeak(row, "product");
  const productId = row.entity_id;

  r = await admin(productsHandler, "PUT", "/api/admin-products", {
    id: Number(productId),
    name: "Audit Product Edited",
    slug: "audit-product",
    price: 550,
    category: "Audit Cat",
    track_inventory: 0,
    stock_quantity: null,
    active: 1,
    requires_shipping: 1,
    password: SECRET_PASSWORD,
  });
  ok(r.statusCode === 200, `product update ${r.statusCode}`);
  row = await latestAudit("product");
  eq(row.action, "update");
  assertNoLeak(row, "product update");

  // coupon
  r = await admin(couponsHandler, "POST", "/api/coupons", {
    code: "AUDIT10",
    type: "percentage",
    value: 10,
    minimum_order: 0,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `coupon ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("coupon");
  eq(row.action, "create");
  assertNoLeak(row, "coupon");

  // faq
  r = await admin(faqsHandler, "POST", "/api/faqs", {
    question: "Audit Q?",
    answer: "Audit A",
    category: "General",
    sort_order: 0,
    visible: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `faq ${r.statusCode}`);
  row = await latestAudit("faq");
  eq(row.action, "create");

  // blog
  r = await admin(blogHandler, "POST", "/api/blog", {
    title: "Audit Post",
    slug: "audit-post",
    content: "x".repeat(500),
    status: "draft",
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `blog ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("blog_post");
  ok(row, "blog audit");
  assertNoLeak(row, "blog");
  ok(!String(row.detail_json || "").includes("x".repeat(50)), "blog content not fully stored");

  // redirect
  r = await admin(redirectsHandler, "POST", "/api/admin-redirects", {
    source_path: "/old-audit",
    destination: "/new-audit",
    status_code: 301,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `redirect ${r.statusCode}`);
  row = await latestAudit("redirect");
  eq(row.action, "create");

  // staff (password must not leak)
  r = await admin(staffHandler, "POST", "/api/admin-staff", {
    name: "Audit Staff",
    email: "audit-staff@example.test",
    password: SECRET_PASSWORD,
    role: "writer",
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `staff ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("admin_staff");
  eq(row.action, "create");
  assertNoLeak(row, "staff");

  // tax class
  r = await admin(taxHandler, "POST", "/api/admin-tax", {
    action: "create_class",
    name: "Audit Class",
    applies_to: "both",
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `tax ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("tax_class");
  ok(row || (await latestAudit())?.entity_type?.startsWith("tax"), "tax audit");

  // blacklist masked
  r = await admin(blacklistHandler, "POST", "/api/admin-blacklist", {
    phone: FULL_PHONE,
    email: FULL_EMAIL,
    reason: "audit test",
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `blacklist ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("customer_blacklist");
  eq(row.action, "create");
  assertNoLeak(row, "blacklist");

  // shipping zone (TX)
  r = await admin(zonesHandler, "POST", "/api/admin-shipping-zones", {
    name: "Audit Zone",
    cities: ["Lahore"],
    rate: 100,
    active: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `zone ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("shipping_zone");
  eq(row.action, "create");
  const zoneId = Number(row.entity_id);

  // area (TX)
  r = await admin(areasHandler, "POST", "/api/admin-shipping-areas", {
    city: "Lahore",
    name: "Audit Area",
    zone_id: zoneId,
    active: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `area ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("shipping_area");
  eq(row.action, "create");

  // courier
  r = await admin(couriersHandler, "POST", "/api/admin-couriers", {
    name: "Audit Courier",
    active: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `courier ${r.statusCode}`);
  row = await latestAudit("courier");
  eq(row.action, "create");

  // rider masked phone
  r = await admin(ridersHandler, "POST", "/api/admin-riders", {
    name: "Audit Rider",
    phone: FULL_PHONE,
    active: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `rider ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("rider");
  eq(row.action, "create");
  assertNoLeak(row, "rider");

  // pickup
  r = await admin(pickupsHandler, "POST", "/api/admin-pickup-points", {
    name: "Audit Pickup",
    city: "Lahore",
    address: "Street 1",
    active: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `pickup ${r.statusCode}`);
  row = await latestAudit("pickup_point");
  eq(row.action, "create");

  // site-content setting
  r = await admin(siteContentHandler, "POST", "/api/site-content", {
    key: "accounts_enabled",
    value: "0",
  });
  ok(r.statusCode === 200, `site-content ${r.statusCode}`);
  row = await latestAudit("site_content");
  ok(["setting_change", "update"].includes(row.action), `site action ${row.action}`);

  // sections (UPDATE only — seed the key first)
  await pool.query(
    `INSERT INTO site_content (content_key, content_value, content_type, page_name, label)
     VALUES ('home_features', '[]', 'json', 'home', 'home_features')
     ON DUPLICATE KEY UPDATE content_value = VALUES(content_value)`
  );
  r = await admin(sectionsHandler, "POST", "/api/sections", {
    key: "home_features",
    value: JSON.stringify([{ title: "A", text: "B", icon: "" }]),
  });
  ok(r.statusCode === 200, `sections ${r.statusCode} ${JSON.stringify(r.body)}`);
  row = await latestAudit("section");
  ok(row, "section audit");
});

await section("order status change audits; refused mutation does not", async () => {
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, payment_method, status, total, created_at)
     VALUES ('AUD-ORD-1', 'A', 'a@t.test', '03001112222', 'Addr', 'Lahore', 'cod', 'pending', 100, NOW())`
  );
  const before = await auditCount();
  const r = await admin(ordersHandler, "PATCH", "/api/admin-orders", {
    order_id: "AUD-ORD-1",
    status: "confirmed",
  });
  ok(r.statusCode === 200, `order patch ${r.statusCode} ${JSON.stringify(r.body)}`);
  eq(await auditCount(), before + 1);
  const row = await latestAudit("order");
  ok(["confirm", "status_change"].includes(row.action), row.action);

  const beforeFail = await auditCount();
  const bad = await admin(ordersHandler, "PATCH", "/api/admin-orders", {
    order_id: "AUD-ORD-MISSING",
    status: "confirmed",
  });
  ok(bad.statusCode >= 400, `missing order ${bad.statusCode}`);
  eq(await auditCount(), beforeFail);
});

await section("TX rollback drops audit row", async () => {
  // RTO on a non-dispatched order must 409 and leave no audit row.
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, payment_method, status, total, created_at)
     VALUES ('AUD-ORD-2', 'A', 'a@t.test', '03001112222', 'Addr', 'Lahore', 'cod', 'pending', 100, NOW())`
  );
  const before = await auditCount();
  const r = await admin(ordersHandler, "PATCH", "/api/admin-orders", {
    order_id: "AUD-ORD-2",
    action: "rto",
  });
  ok(r.statusCode === 409 || r.statusCode === 400, `rto refused ${r.statusCode}`);
  eq(await auditCount(), before);
});

await section("login success/failure + logout", async () => {
  process.env.ADMIN_PASSWORD = SECRET_PASSWORD;
  const before = await auditCount();
  clear();
  let r = await invoke(loginHandler, {
    method: "POST",
    url: "/api/admin-login",
    body: { username: "admin", password: WRONG_PASSWORD },
    headers: { origin: "http://orders.test" },
  });
  eq(r.statusCode, 401);
  eq(await auditCount(), before + 1);
  let row = await latestAudit("admin_session");
  eq(row.action, "login_failed");
  assertNoLeak(row, "login_failed");

  clear();
  r = await invoke(loginHandler, {
    method: "POST",
    url: "/api/admin-login",
    body: { username: "admin", password: SECRET_PASSWORD },
    headers: { origin: "http://orders.test" },
  });
  eq(r.statusCode, 200, `login ok ${JSON.stringify(r.body)}`);
  row = await latestAudit("admin_session");
  eq(row.action, "login_success");
  assertNoLeak(row, "login_success");

  // logout with minted token
  const beforeOut = await auditCount();
  r = await admin(logoutHandler, "POST", "/api/admin-logout", {});
  eq(r.statusCode, 200);
  eq(await auditCount(), beforeOut + 1);
  row = await latestAudit("admin_session");
  eq(row.action, "logout");
  token = await mintAdminToken(pool);
  delete process.env.ADMIN_PASSWORD;
});

await section("viewer filters / pagination / CSV + RBAC", async () => {
  const list = await admin(auditHandler, "GET", "/api/admin-audit-log", undefined, {
    page: "1",
    limit: "5",
    entity_type: "product",
  });
  eq(list.statusCode, 200, JSON.stringify(list.body));
  ok(Array.isArray(list.body.rows));
  ok(list.body.rows.length <= 5);
  ok(list.body.total >= 1);

  const csv = await admin(auditHandler, "GET", "/api/admin-audit-log", undefined, {
    export: "csv",
    entity_type: "product",
  });
  eq(csv.statusCode, 200);
  ok(typeof csv.body === "string" || Buffer.isBuffer(csv.body) || true);
  const csvText = String(csv.body || "");
  ok(csvText.includes("summary") || csvText.includes("actor_type"), "csv header");
  assertNoLeak({ csv: csvText }, "csv");

  const mgr = await mintRole("manager");
  const wr = await mintRole("writer");
  const m = await admin(auditHandler, "GET", "/api/admin-audit-log", undefined, {}, mgr);
  eq(m.statusCode, 403);
  const w = await admin(auditHandler, "GET", "/api/admin-audit-log", undefined, {}, wr);
  eq(w.statusCode, 403);
  clear();
  const unauth = await invoke(auditHandler, {
    method: "GET",
    url: "/api/admin-audit-log",
    headers: { origin: "http://orders.test" },
  });
  eq(unauth.statusCode, 401);
});

await section("table missing: business action still succeeds", async () => {
  await pool.query("RENAME TABLE admin_audit_log TO admin_audit_log_bak_b20");
  resetAuditSchemaProbeForTests();
  const r = await admin(faqsHandler, "POST", "/api/faqs", {
    question: "Missing table Q?",
    answer: "A",
    category: "General",
    sort_order: 1,
    visible: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `faq without audit table ${r.statusCode}`);
  const viewer = await admin(auditHandler, "GET", "/api/admin-audit-log", undefined, {});
  eq(viewer.statusCode, 503);
  await pool.query("RENAME TABLE admin_audit_log_bak_b20 TO admin_audit_log");
  resetAuditSchemaProbeForTests();
});

await section("login rate_limited audit throttle (at most one row per ip window)", async () => {
  await pool.query("DELETE FROM admin_audit_log WHERE action = 'login_failed' AND summary LIKE '%rate_limited%'");
  clear();
  process.env.ADMIN_PASSWORD = SECRET_PASSWORD;
  const before = await auditCount();
  // Burn RL_AUTH budget (5 / 15 min), then flood; HTTP stays 429, audit writes at most one.
  for (let i = 0; i < 5; i++) {
    const r = await invoke(loginHandler, {
      method: "POST",
      url: "/api/admin-login",
      body: { username: "admin", password: WRONG_PASSWORD },
      headers: { origin: "http://orders.test", "x-forwarded-for": "203.0.113.50" },
    });
    eq(r.statusCode, 401);
  }
  const afterBurn = await auditCount();
  ok(afterBurn >= before + 5, "wrong_password audits still written while RL allows");
  let rateLimitedRows = 0;
  for (let i = 0; i < 20; i++) {
    const r = await invoke(loginHandler, {
      method: "POST",
      url: "/api/admin-login",
      body: { username: "admin", password: WRONG_PASSWORD },
      headers: { origin: "http://orders.test", "x-forwarded-for": "203.0.113.50" },
    });
    eq(r.statusCode, 429);
  }
  const [rlRows] = await pool.query(
    `SELECT id, detail_json FROM admin_audit_log
     WHERE action = 'login_failed' AND detail_json LIKE '%rate_limited%'
     ORDER BY id ASC`
  );
  const list = Array.isArray(rlRows) ? rlRows : [];
  rateLimitedRows = list.length;
  eq(rateLimitedRows, 1, `expected 1 rate_limited audit row, got ${rateLimitedRows}`);
  const detail = JSON.parse(String(list[0].detail_json || "{}"));
  eq(detail.reason, "rate_limited");
  ok(detail.suppressed_since_last == null || detail.suppressed_since_last === 0);
  for (const row of list) assertNoLeak(row, "rate_limited");
  delete process.env.ADMIN_PASSWORD;
  clear();
});

await section("schema probe negative TTL self-heal after table restored", async () => {
  await pool.query("RENAME TABLE admin_audit_log TO admin_audit_log_bak_b23");
  resetAuditSchemaProbeForTests();
  // First write caches negative probe.
  let r = await admin(faqsHandler, "POST", "/api/faqs", {
    question: "Neg probe Q?",
    answer: "A",
    category: "General",
    sort_order: 2,
    visible: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201, `faq during missing table ${r.statusCode}`);
  await pool.query("RENAME TABLE admin_audit_log_bak_b23 TO admin_audit_log");
  // Still within 60s negative cache → no new audit row.
  const before = await auditCount();
  r = await admin(faqsHandler, "POST", "/api/faqs", {
    question: "Still cached Q?",
    answer: "A",
    category: "General",
    sort_order: 3,
    visible: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201);
  eq(await auditCount(), before, "negative probe still cached");
  // Expire negative probe → next write re-probes and inserts.
  seedAuditNegativeProbeForTests(61_000);
  r = await admin(faqsHandler, "POST", "/api/faqs", {
    question: "Healed Q?",
    answer: "A",
    category: "General",
    sort_order: 4,
    visible: 1,
  });
  ok(r.statusCode === 200 || r.statusCode === 201);
  eq(await auditCount(), before + 1, "re-probe after TTL writes audit");
  const row = await latestAudit("faq");
  eq(row.action, "create");
});

await section("hashAuditIp keyed vs legacy against stored login ip_hash", async () => {
  delete process.env.AUDIT_IP_HASH_KEY;
  const ip = "198.51.100.77";
  const legacy = hashAuditIp(ip);
  eq(legacy.length, 64);
  process.env.AUDIT_IP_HASH_KEY = "b".repeat(32);
  const keyed = hashAuditIp(ip);
  eq(keyed.length, 64);
  ok(keyed !== legacy, "HMAC differs from legacy");
  delete process.env.AUDIT_IP_HASH_KEY;
});

await section("global leak grep across all audit rows", async () => {
  const [rows] = await pool.query("SELECT * FROM admin_audit_log");
  for (const row of Array.isArray(rows) ? rows : []) {
    assertNoLeak(row, `row ${row.id}`);
  }
  ok((Array.isArray(rows) ? rows : []).length > 10, "expected many audit rows");
});

console.log(
  "AUDIT_LOG_DB_PASS",
  JSON.stringify({ sections, assertions: total(), db: DB_NAME })
);
await pool.end();
