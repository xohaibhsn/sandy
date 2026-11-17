/**
 * ADMIN-SEARCH-01 — local MariaDB integration test (127.0.0.1:3307 / sandy_test_local).
 *
 * Runs lib/adminSearchQuery.ts (runAdminSearch + parseAdminSearchQuery) against real MariaDB with
 * seeded rows. Seeds are prefixed `AS1-` (orders) / `AS1 ` (products, blog posts, FAQs) and only those
 * rows are ever deleted. Covers: search across all groups, % and _ wildcard escaping, unicode,
 * writer vs manager vs super_admin role scope, per-group limit, customers dedupe, and that
 * receipt_path / payment_reference are never returned or searchable.
 *
 * Env: SANDY_TEST_DB_PASSWORD
 * Run: node tests/admin-search-db.test.mjs
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.removeAllListeners("warning");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[mc]?[jt]sx?$/.test(specifier)
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

const S = await import(pathToFileURL(path.join(root, "lib/adminSearchQuery.ts")).href);
const { ADMIN_SEARCH_GROUP_LIMIT, ADMIN_SEARCH_MAX, ADMIN_SEARCH_MIN, groupsForRole, parseAdminSearchQuery, runAdminSearch } = S;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: true,
});

let assertions = 0;
const sections = [];
async function check(name, fn) {
  try {
    await fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};

const MANAGER = "manager";
const SUPER = "super_admin";
const WRITER = "writer";

async function addColumn(table, ddl) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    /* already present */
  }
}

async function ensureTables() {
  // Additive only; mirrors lib/ensureShopTables.ts, pages/api/blog.ts and pages/api/faqs.ts.
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(255), active TINYINT(1) DEFAULT 1)`);
  await addColumn("products", "slug VARCHAR(255)");
  await pool.query(`CREATE TABLE IF NOT EXISTS blog_posts (
    id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(500) NOT NULL, slug VARCHAR(500), status VARCHAR(20) DEFAULT 'published')`);
  await addColumn("blog_posts", "slug VARCHAR(500)");
  await addColumn("blog_posts", "status VARCHAR(20) DEFAULT 'published'");
  await pool.query(`CREATE TABLE IF NOT EXISTS faqs (
    id INT AUTO_INCREMENT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL)`);
}

async function cleanup() {
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'AS1-%'");
  await pool.query("DELETE FROM products WHERE name LIKE 'AS1 %'");
  await pool.query("DELETE FROM blog_posts WHERE title LIKE 'AS1 %'");
  await pool.query("DELETE FROM faqs WHERE question LIKE 'AS1 %'");
}

const SECRET_RECEIPT = "/uploads/receipts/AS1SECRETRECEIPT.png";
const SECRET_REF = "AS1SECRETREF-7788";

async function ensureOptionalOrderCols() {
  // Local sandy_test_local may be a slim orders schema; add optional cols if missing.
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
  await ensureOptionalOrderCols();
  const orders = [];
  const o = (id, name, email, phone, status, created) =>
    orders.push([id, name, email, phone, 100, status, "bank", SECRET_RECEIPT, SECRET_REF, created]);

  o("AS1-1001", "Alice Zephyr", "alice.zephyr@as1.test", "+923001110001", "pending", "2026-03-01 10:00:00");
  o("AS1-1002", "Bob 100% Real", "bob_real@as1.test", "+923001110002", "confirmed", "2026-03-02 10:00:00");
  o("AS1-1003", "Bob 100X Real", "bobXreal@as1.test", "+923001110003", "delivered", "2026-03-03 10:00:00");
  o("AS1-1004", "Zoë Müller 北京", "zoe.muller@as1.test", "+923001110004", "pending", "2026-03-04 10:00:00");
  o("AS1-1005", "Phone Only", "phone.only@as1.test", "+92-300-5550199", "pending", "2026-03-05 10:00:00");
  // One customer, 8 orders -> customers group dedupes by email, orders group limits to 5.
  for (let i = 1; i <= 8; i += 1) {
    o(`AS1-M-${String(i).padStart(2, "0")}`, "Multi Buyer", "multi@as1.test", "+923001119999", "pending", `2026-04-0${i} 09:00:00`);
  }
  // 7 distinct customers -> customers group limits to 5.
  for (let i = 1; i <= 7; i += 1) {
    o(`AS1-L-${String(i).padStart(2, "0")}`, `Limit Cust ${i}`, `limit${i}@as1.test`, `+92300222000${i}`, "pending", `2026-05-0${i} 09:00:00`);
  }
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, total, status, payment_method,
                         receipt_path, payment_reference, created_at) VALUES ?`,
    [orders]
  );

  await pool.query("INSERT INTO products (name, slug, active) VALUES ?", [
    [
      ["AS1 Widget 100%", "as1-widget-100pct", 1],
      ["AS1 Widget 100X", "as1-widget-100x", 1],
      ["AS1 Under_score", "as1-under-score", 1],
      ["AS1 UnderXscore", "as1-underxscore", 1],
      ...Array.from({ length: 7 }, (_, i) => [`AS1 Bulk Product ${i + 1}`, `as1-bulk-product-${i + 1}`, 1]),
    ],
  ]);
  await pool.query("INSERT INTO blog_posts (title, slug, status) VALUES ?", [
    [
      ["AS1 Café ☕ guide", "as1-cafe-guide", "published"],
      ["AS1 Draft Only Post", "as1-draft-only", "draft"],
      ...Array.from({ length: 7 }, (_, i) => [`AS1 Bulk Blog ${i + 1}`, `as1-bulk-blog-${i + 1}`, "published"]),
    ],
  ]);
  await pool.query("INSERT INTO faqs (question, answer) VALUES ?", [
    [
      ["AS1 How do I reset 100% of my settings?", "answer"],
      ["AS1 Où est ma commande ? 配送", "answer"],
      ...Array.from({ length: 7 }, (_, i) => [`AS1 Bulk FAQ ${i + 1}?`, "answer"]),
    ],
  ]);
}

const search = (q, role = MANAGER) => runAdminSearch(pool, q, role);

async function main() {
  await ensureTables();
  await cleanup();
  await seed();

  await check("parseAdminSearchQuery bounds", () => {
    eq(ADMIN_SEARCH_MIN, 2);
    eq(ADMIN_SEARCH_MAX, 80);
    eq(ADMIN_SEARCH_GROUP_LIMIT, 5);
    eq(parseAdminSearchQuery("a"), null);
    eq(parseAdminSearchQuery(" a "), null);
    eq(parseAdminSearchQuery(""), null);
    eq(parseAdminSearchQuery(undefined), null);
    eq(parseAdminSearchQuery(["ab"]), null);
    eq(parseAdminSearchQuery("ab"), "ab");
    eq(parseAdminSearchQuery("  ab  "), "ab");
    eq(parseAdminSearchQuery("x".repeat(80)), "x".repeat(80));
    eq(parseAdminSearchQuery("x".repeat(81)), null);
  });

  await check("role scope helper", () => {
    eq(groupsForRole(SUPER), ["orders", "customers", "products", "blog", "faqs"]);
    eq(groupsForRole(MANAGER), ["orders", "customers", "products", "blog", "faqs"]);
    eq(groupsForRole(WRITER), ["blog", "faqs"]);
    eq(groupsForRole("something_else"), ["blog", "faqs"]);
  });

  await check("manager: search across all groups", async () => {
    const g = await search("AS1-1001");
    eq(Object.keys(g).sort(), ["blog", "customers", "faqs", "orders", "products"]);
    eq(g.orders.map((r) => r.order_id), ["AS1-1001"]);
    eq(g.orders[0].customer_name, "Alice Zephyr");
    eq(g.orders[0].customer_email, "alice.zephyr@as1.test");
    eq(g.orders[0].status, "pending");
    eq(g.customers, []);
    eq(g.products, []);

    const byName = await search("Alice Zephyr");
    eq(byName.orders.map((r) => r.order_id), ["AS1-1001"]);
    eq(byName.customers.map((r) => r.customer_email), ["alice.zephyr@as1.test"]);
    eq(byName.customers[0].order_count, 1);

    const byEmail = await search("alice.zephyr@as1");
    eq(byEmail.orders.map((r) => r.order_id), ["AS1-1001"]);
    eq(byEmail.customers.map((r) => r.customer_email), ["alice.zephyr@as1.test"]);

    const byPhone = await search("300-5550199");
    eq(byPhone.orders.map((r) => r.order_id), ["AS1-1005"]);
    eq(byPhone.customers, [], "customers group matches name/email only, not phone");

    const prod = await search("AS1 Widget");
    eq(prod.products.map((r) => r.name).sort(), ["AS1 Widget 100%", "AS1 Widget 100X"]);
    ok(prod.products.every((r) => typeof r.id === "number" && r.slug.startsWith("as1-widget")));

    const bySlug = await search("as1-widget-100x");
    eq(bySlug.products.map((r) => r.name), ["AS1 Widget 100X"]);

    const blog = await search("Draft Only");
    eq(blog.blog.map((r) => r.title), ["AS1 Draft Only Post"]);
    eq(blog.blog[0].status, "draft");
    eq(blog.blog[0].slug, "as1-draft-only");

    const faq = await search("reset 100%");
    eq(faq.faqs.map((r) => r.question), ["AS1 How do I reset 100% of my settings?"]);
  });

  await check("wildcards % and _ are literal", async () => {
    // "%" must match only the literal percent sign.
    const pct = await search("100% Real");
    eq(pct.orders.map((r) => r.order_id), ["AS1-1002"]);
    eq(pct.customers.map((r) => r.customer_email), ["bob_real@as1.test"]);
    const pctProd = await search("Widget 100%");
    eq(pctProd.products.map((r) => r.name), ["AS1 Widget 100%"]);
    const pctFaq = await search("reset 100%");
    eq(pctFaq.faqs.map((r) => r.question), ["AS1 How do I reset 100% of my settings?"]);

    // "_" must match only the literal underscore (not any single character).
    const us = await search("bob_real");
    eq(us.orders.map((r) => r.order_id), ["AS1-1002"]);
    eq(us.customers.map((r) => r.customer_email), ["bob_real@as1.test"]);
    const prodUs = await search("Under_score");
    eq(prodUs.products.map((r) => r.name), ["AS1 Under_score"]);

    // A bare wildcard-only query must not behave like match-all.
    const onlyPct = await search("%%");
    eq(onlyPct.orders, []);
    eq(onlyPct.products, []);
    eq(onlyPct.blog, []);
    eq(onlyPct.faqs, []);
    const onlyUs = await search("__");
    eq(onlyUs.orders, []);
    eq(onlyUs.customers, []);
    eq(onlyUs.products, []);

    // A backslash is literal, not an escape for the next character.
    const bs = await search("\\%");
    eq(bs.orders, []);
    eq(bs.products, []);

    // SQL metacharacters are inert (parameterised).
    const inj = await search("' OR 1=1 --");
    eq(inj.orders, []);
    eq(inj.customers, []);
    eq(inj.products, []);
    eq(inj.blog, []);
    eq(inj.faqs, []);
  });

  await check("unicode (accents, CJK, emoji)", async () => {
    const accent = await search("Müller");
    eq(accent.orders.map((r) => r.order_id), ["AS1-1004"]);
    eq(accent.customers.map((r) => r.customer_name), ["Zoë Müller 北京"]);
    const cjk = await search("北京");
    eq(cjk.orders.map((r) => r.order_id), ["AS1-1004"]);
    const cjkFaq = await search("配送");
    eq(cjkFaq.faqs.map((r) => r.question), ["AS1 Où est ma commande ? 配送"]);
    const emoji = await search("☕");
    eq(emoji.blog.map((r) => r.title), ["AS1 Café ☕ guide"]);
    const cafe = await search("Café");
    eq(cafe.blog.map((r) => r.title), ["AS1 Café ☕ guide"]);
  });

  await check("limits: 5 per group; customers deduped by email", async () => {
    const m = await search("multi@as1.test");
    eq(m.orders.length, 5, "orders limited to 5 (8 match)");
    ok(m.orders.every((r) => r.order_id.startsWith("AS1-M-")));
    eq(m.customers.length, 1, "8 orders of one email -> 1 customer");
    eq(m.customers[0].customer_email, "multi@as1.test");
    eq(m.customers[0].order_count, 8);
    eq(m.customers[0].customer_name, "Multi Buyer");

    // Newest first.
    eq(m.orders.map((r) => r.order_id), ["AS1-M-08", "AS1-M-07", "AS1-M-06", "AS1-M-05", "AS1-M-04"]);

    const l = await search("Limit Cust");
    eq(l.orders.length, 5);
    eq(l.customers.length, 5, "7 distinct customers limited to 5");

    eq((await search("AS1 Bulk Product")).products.length, 5);
    eq((await search("AS1 Bulk Blog")).blog.length, 5);
    eq((await search("AS1 Bulk FAQ")).faqs.length, 5);

    // Explicit limit override is honoured.
    const two = await runAdminSearch(pool, "AS1 Bulk", MANAGER, 2);
    eq(two.products.length, 2);
    eq(two.blog.length, 2);
    eq(two.faqs.length, 2);
  });

  await check("super_admin matches manager scope", async () => {
    const a = await search("AS1 Widget", SUPER);
    const b = await search("AS1 Widget", MANAGER);
    eq(Object.keys(a).sort(), Object.keys(b).sort());
    eq(a.products, b.products);
  });

  await check("writer: only blog and faqs (server-side)", async () => {
    // Queries that would hit orders/customers/products for a manager.
    for (const q of ["AS1-1001", "Alice Zephyr", "alice.zephyr@as1", "AS1 Widget", "multi@as1.test"]) {
      const w = await search(q, WRITER);
      eq(Object.keys(w).sort(), ["blog", "faqs"], `writer keys for ${q}`);
      ok(w.orders === undefined && w.customers === undefined && w.products === undefined);
    }
    const w = await search("AS1 Bulk", WRITER);
    eq(w.blog.length, 5);
    eq(w.faqs.length, 5);
    const wCafe = await search("Café", WRITER);
    eq(wCafe.blog.map((r) => r.title), ["AS1 Café ☕ guide"]);
    // Unknown roles get the same least-privilege scope.
    const u = await search("AS1-1001", "nobody");
    eq(Object.keys(u).sort(), ["blog", "faqs"]);
  });

  await check("secrets: receipt_path / payment_reference never returned or searchable", async () => {
    const m = await search("AS1-M-01");
    const json = JSON.stringify(m);
    ok(!json.includes("SECRETRECEIPT") && !json.includes("SECRETREF"), "no secret values in payload");
    for (const row of m.orders) {
      eq(Object.keys(row).sort(), ["created_at", "customer_email", "customer_name", "order_id", "status"]);
    }
    const mc = await search("multi@as1.test");
    eq(mc.customers.length, 1);
    for (const row of mc.customers) {
      eq(Object.keys(row).sort(), ["customer_email", "customer_name", "last_order", "order_count"]);
    }
    const bySecret = await search("SECRETREF");
    eq(bySecret.orders, []);
    const byReceipt = await search("SECRETRECEIPT");
    eq(byReceipt.orders, []);
  });

  console.log(
    "AS1_DB_PASS",
    JSON.stringify({ assertions, sections: sections.length, section_names: sections })
  );
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error("AS1_DB_FAIL", e);
} finally {
  try {
    await cleanup();
  } catch (e) {
    console.error("AS1_DB_CLEANUP_FAIL", e && e.message);
    failed = true;
  }
  await pool.end();
}
process.exit(failed ? 1 : 0);
