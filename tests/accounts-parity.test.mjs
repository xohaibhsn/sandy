/**
 * Customer accounts (BATCH-09) — flag-OFF parity test.
 *
 * With accounts_enabled absent (and explicitly "0"), the shop must behave exactly as before accounts existed:
 *   - every /api/account/* route answers 404 { error: "Not found" } (no cookie, no DB write),
 *   - checkout (pages/api/orders.ts) keeps the HEAD response shape and inserts orders with customer_id NULL,
 *   - the admin-accounts-settings endpoint still reports the flag as off.
 * Runs the REAL handlers against sandy_mig_orders (127.0.0.1:3307), schema from migrations only.
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)   Run: node tests/accounts-parity.test.mjs
 * (shares the dedicated DB with the other orders tests: do not run in parallel)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  checkoutBody,
  count,
  createPool,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  one,
  rebuildFromMigrations,
  requirePassword,
  root,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.OTP_PROVIDER = "mock";
process.env.NODE_ENV = "test";

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetAccountSettingsCache } = await importFromRoot("lib/accountSettings.ts");
const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const { eq, ok, total } = makeAssertions(assert);
const clear = () => __rateLimitTestUtils.clearStore();

/** Frozen from cod-protect-parity (HEAD checkout success shape): accounts must not add or reorder keys. */
const HEAD_SUCCESS_KEYS = [
  "success",
  "order_id",
  "whatsappUrl",
  "telegramUrl",
  "subtotal",
  "shipping",
  "vat_amount",
  "tax_label",
  "tax_lines",
  "discount_amount",
  "total",
  "coupon_code",
  "items",
];
const ACCOUNT_LEAKS = ["customer_id", "customer", "account", "accounts_enabled", "session"];

/** Every file under pages/api/account is a route; the list is discovered so a new route cannot dodge the gate. */
function discoverAccountRoutes() {
  const base = path.join(root, "pages", "api", "account");
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
      else if (/\.ts$/.test(name)) out.push(`${rel}${name.replace(/\.ts$/, "")}`);
    }
  };
  walk(base, "");
  return out.map((r) => (r.endsWith("/index") ? r.slice(0, -"/index".length) : r)).sort();
}

async function setFlag(value) {
  await pool.query("DELETE FROM site_content WHERE content_key = 'accounts_enabled'");
  if (value !== null) {
    await pool.query(
      "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES ('accounts_enabled', ?, 'text', 'settings', 'accounts_enabled')",
      [value]
    );
  }
  resetAccountSettingsCache();
}

let failure = null;
try {
  console.log("accounts-parity");
  await pool.query(
    `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
     VALUES ('Acct Parity A', 'acct-parity-a', 1000, 'Accessories', 'In Stock', 0, NULL, 1)`
  );
  const productId = (await one(pool, "SELECT id FROM products WHERE slug = 'acct-parity-a'")).id;
  await pool.query("DELETE FROM site_content WHERE content_key LIKE 'cod\\_%' OR content_key = 'advance_methods'");

  const routes = discoverAccountRoutes();
  console.log(`> discovered ${routes.length} account routes: ${routes.join(", ")}`);
  eq(routes, [
    "addresses",
    "delete",
    "login-start",
    "login-verify",
    "logout",
    "me",
    "orders",
    "orders/[orderId]",
    "orders/claim",
    "profile",
    "wishlist",
  ].sort(), "route inventory (update this list when a route is added so the gate test covers it)");

  // a real customer + session exist, so a 404 can only come from the flag gate
  const [r] = await pool.query("INSERT INTO customers (phone_norm, name) VALUES ('03330009999', 'Parity')");
  const { createCustomerSession } = await importFromRoot("lib/customerAuth.ts");
  const token = await createCustomerSession(Number(r.insertId));

  const modules = {};
  for (const route of routes) {
    const file = route === "orders" ? "orders/index" : route;
    modules[route] = (await importFromRoot(`pages/api/account/${file}.ts`)).default;
  }

  for (const flag of [null, "0"]) {
    console.log(`> flag ${flag === null ? "absent" : '"0"'}: all account routes 404`);
    await setFlag(flag);
    for (const route of routes) {
      for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
        for (const cookies of [{}, { sCustomerSession: token }]) {
          clear();
          const res = await invoke(modules[route], {
            method,
            url: `/api/account/${route}`,
            body: { phone: "03330009999", confirm: "DELETE", productId: productId },
            query: { orderId: "ORD-1", id: "1", productId: String(productId) },
            cookies,
            headers: { origin: "http://orders.test" },
          });
          eq(res.statusCode, 404, `${method} /api/account/${route} (flag ${flag}) -> ${res.statusCode}`);
          eq(res.body, { error: "Not found" });
          ok(!res.headers["set-cookie"], "no Set-Cookie");
        }
      }
    }
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), 0, "no OTP challenge created");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers"), 1, "no customer created");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses"), 0);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist"), 0);

    console.log(`> flag ${flag === null ? "absent" : '"0"'}: checkout response shape + orders.customer_id NULL`);
    for (const withCookie of [false, true]) {
      clear();
      const body = checkoutBody({
        customer_phone: "03330009999",
        customer_email: "parity.accounts@example.test",
        items: [{ id: productId, qty: 1 }],
        payment_method: "cod",
      });
      const res = await invoke(ordersHandler, { url: "/api/orders", body, cookies: withCookie ? { sCustomerSession: token } : {} });
      eq(res.statusCode, 200, JSON.stringify(res.body));
      eq(Object.keys(res.body), HEAD_SUCCESS_KEYS, "success keys (and order) match HEAD");
      for (const k of ACCOUNT_LEAKS) ok(!(k in res.body), `account field ${k} must not appear in the checkout response`);
      eq(res.body.total, 1180);
      eq(res.body.items.length, 1);
      const row = await one(pool, "SELECT customer_id, customer_phone_norm FROM orders WHERE order_id = ?", [res.body.order_id]);
      eq(row.customer_id, null, `customer_id NULL (cookie ${withCookie})`);
      eq(row.customer_phone_norm, null, "protection columns untouched with flags off");
      eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?", [res.body.order_id]), 1);
      eq(await count(pool, "SELECT COUNT(*) AS c FROM order_tax_snapshots WHERE order_id = ?", [res.body.order_id]), 1);

      // idempotent replay is unchanged too
      clear();
      const replay = await invoke(ordersHandler, { url: "/api/orders", body, cookies: withCookie ? { sCustomerSession: token } : {} });
      eq(replay.statusCode, 200);
      eq(replay.body.order_id, res.body.order_id, "replay returns the same order");
      for (const k of ACCOUNT_LEAKS) ok(!(k in replay.body), `account field ${k} must not appear in the replay`);
      await new Promise((r2) => setTimeout(r2, 3));
    }
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE customer_id IS NOT NULL"), 0, "no order was ever linked while off");
    await pool.query("DELETE FROM order_tax_snapshots");
    await pool.query("DELETE FROM order_items");
    await pool.query("DELETE FROM orders");
    await pool.query("DELETE FROM order_checkout_attempts");
  }

  // the checkout path survives an unreachable accounts table set (flag off never touches it)
  console.log("> flag off: checkout does not depend on account tables");
  await setFlag(null);
  await pool.query("RENAME TABLE customer_sessions TO customer_sessions_hidden");
  try {
    clear();
    const res = await invoke(ordersHandler, {
      url: "/api/orders",
      cookies: { sCustomerSession: crypto.randomBytes(32).toString("hex") },
      body: checkoutBody({
        customer_phone: "03330008888",
        customer_email: "nodeps@example.test",
        items: [{ id: productId, qty: 1 }],
        payment_method: "cod",
      }),
    });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq((await one(pool, "SELECT customer_id FROM orders WHERE order_id = ?", [res.body.order_id])).customer_id, null);
  } finally {
    await pool.query("RENAME TABLE customer_sessions_hidden TO customer_sessions").catch(() => {});
  }
} catch (e) {
  failure = e;
} finally {
  await pool.query("RENAME TABLE customer_sessions_hidden TO customer_sessions").catch(() => {});
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("FAILED:", failure.message);
  if (failure.stack) console.error(failure.stack.split("\n").slice(1, 6).join("\n"));
  process.exit(1);
}
console.log(`accounts-parity: ${total()} assertions — all green (flag-off: account routes 404, checkout shape == HEAD, customer_id NULL)`);
