/**
 * SANDY-BATCH-05 Phase 2 — checkout / cancel / idempotency against a database built ONLY from migrations.
 *
 * The REAL handlers (pages/api/orders.ts, admin-orders.ts, admin-products.ts, admin-orders-export.ts) run
 * in-process against sandy_mig_orders (127.0.0.1:3307). The schema comes from migrations/0001 + 0002 + the
 * tax SQL; the application no longer creates or alters shop tables, so any missing table/column would fail.
 *
 * Covers: Rs.999 + WELCOME10 (discount 100 whole-rupee, taxable 899, tax 162, total 1061), no coupon
 * (tax 180, total 1179), idempotency replay / mismatch, stock decrement, failed checkout leaves nothing behind,
 * tax snapshot written in the same transaction, cancel restores stock + coupon use, and an empty products table
 * stays EMPTY (no seed) after checkout attempts and admin reads.
 *
 * Env: SANDY_TEST_DB_PASSWORD   Run: node tests/orders-migrations-db.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  root,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const orders = (await importFromRoot("pages/api/orders.ts")).default;
const adminOrders = (await importFromRoot("pages/api/admin-orders.ts")).default;
const adminOrdersExport = (await importFromRoot("pages/api/admin-orders-export.ts")).default;
const adminProducts = (await importFromRoot("pages/api/admin-products.ts")).default;

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
async function checkout(body) {
  __rateLimitTestUtils.clearStore();
  await sleep(5); // order ids are ORD-<ms>
  return invoke(orders, { url: "/api/orders", body });
}
const money = (v) => Number(Number(v).toFixed(2));

let failure = null;
try {
  await section("schema comes from migrations only (no runtime DDL left in the shop code)", async () => {
    for (const t of ["products", "orders", "order_items", "order_checkout_attempts", "order_tax_snapshots", "tax_classes"]) {
      eq(await count(pool, "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]), 1, `table ${t}`);
    }
    for (const rel of ["lib/ensureShopTables.ts", "lib/ensureOrderIdempotency.ts"]) {
      let exists = true;
      try {
        readFileSync(path.join(root, rel));
      } catch {
        exists = false;
      }
      eq(exists, false, `${rel} is deleted`);
    }
    for (const rel of [
      "pages/api/orders.ts",
      "pages/api/admin-orders.ts",
      "pages/api/admin-orders-export.ts",
      "pages/api/admin-products.ts",
      "app/category/[slug]/page.tsx",
    ]) {
      const src = readFileSync(path.join(root, rel), "utf8");
      ok(!/ensureShopTables|ensureProductsTable|ensureOrderIdempotency/.test(src), `${rel} has no shop ensure* call`);
    }
  });

  await section("empty products table stays EMPTY after checkout attempts and admin reads", async () => {
    eq(await count(pool, "SELECT COUNT(*) AS c FROM products"), 0, "starts empty");
    const token = await mintAdminToken(pool);

    const res = await checkout(checkoutBody({ items: [{ id: 1, qty: 1 }] }));
    eq(res.statusCode, 400, JSON.stringify(res.body));
    eq(res.body, { error: "One or more products are unavailable" });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), 0, "no order");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"), 0, "attempt claim rolled back");

    for (const [h, query] of [
      [adminProducts, {}],
      [adminOrders, { page: "1", pageSize: "10" }],
      [adminOrdersExport, {}],
    ]) {
      __rateLimitTestUtils.clearStore();
      const r = await invoke(h, { method: "GET", url: "/api/admin", query, ...adminReq(token) });
      eq(r.statusCode, 200, `admin GET ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    eq(await count(pool, "SELECT COUNT(*) AS c FROM products"), 0, "products still empty (no seed-if-empty)");
  });

  // ---- catalogue + coupon fixtures
  await pool.query(
    `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
     VALUES ('Phone Case', 'phone-case', 999, 'Accessories', '10', 1, 10, 1)`
  );
  const product = await one(pool, "SELECT id FROM products WHERE slug = 'phone-case'");
  await pool.query("INSERT INTO coupons (code, type, value, minimum_order) VALUES ('WELCOME10','percentage',10,0)");
  const stockOf = async () => Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [product.id])).q);
  const couponUses = async () => Number((await one(pool, "SELECT used_count AS u FROM coupons WHERE code = 'WELCOME10'")).u);
  const items = [{ id: product.id, qty: 1 }];

  let couponOrderId = "";
  const couponKey = checkoutBody().idempotency_key;
  const couponBody = checkoutBody({ items, coupon_code: "welcome10", idempotency_key: couponKey });

  await section("Rs.999 + WELCOME10: discount 100, taxable 899, tax 162, total 1061", async () => {
    const res = await checkout(couponBody);
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq(money(res.body.subtotal), 999);
    eq(money(res.body.discount_amount), 100);
    eq(money(res.body.vat_amount), 162);
    eq(money(res.body.total), 1061);
    eq(res.body.coupon_code, "WELCOME10");
    eq(res.body.tax_lines.length, 1);
    eq(money(res.body.tax_lines[0].taxable_amount), 899);
    eq(money(res.body.tax_lines[0].tax_amount), 162);
    eq(money(res.body.tax_lines[0].rate_percent), 18);
    couponOrderId = res.body.order_id;

    const row = await one(pool, "SELECT * FROM orders WHERE order_id = ?", [couponOrderId]);
    eq(money(row.total), 1061);
    eq(money(row.discount_amount), 100);
    eq(money(row.vat_amount), 162);
    eq(row.coupon_code, "WELCOME10");
    eq(row.status, "pending");
    eq(row.payment_method, "cod");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?", [couponOrderId]), 1);
  });

  await section("stock decrements and coupon use is counted", async () => {
    eq(await stockOf(), 9);
    eq(await couponUses(), 1);
    const p = await one(pool, "SELECT stock FROM products WHERE id = ?", [product.id]);
    eq(String(p.stock), "9", "stock label follows quantity");
  });

  await section("tax snapshot is written in the same transaction as the order", async () => {
    const snap = await one(pool, "SELECT tax_label, vat_amount, snapshot_json FROM order_tax_snapshots WHERE order_id = ?", [couponOrderId]);
    ok(snap, "snapshot row exists for the order");
    eq(money(snap.vat_amount), 162);
    ok(String(snap.tax_label).length > 0);

    // Make the snapshot insert fail: the whole checkout (order, items, attempt claim, stock, coupon) must roll back.
    const ordersBefore = await count(pool, "SELECT COUNT(*) AS c FROM orders");
    const attemptsBefore = await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts");
    const stockBefore = await stockOf();
    const usesBefore = await couponUses();
    await pool.query("RENAME TABLE order_tax_snapshots TO order_tax_snapshots_hidden");
    let res;
    try {
      res = await checkout(checkoutBody({ items, coupon_code: "WELCOME10" }));
    } finally {
      await pool.query("RENAME TABLE order_tax_snapshots_hidden TO order_tax_snapshots");
    }
    eq(res.statusCode, 503, JSON.stringify(res.body));
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), ordersBefore, "no order persisted");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"), attemptsBefore, "no attempt persisted");
    eq(await stockOf(), stockBefore, "stock untouched");
    eq(await couponUses(), usesBefore, "coupon use untouched");
  });

  await section("idempotency: replay returns the same order; changed body conflicts; nothing is duplicated", async () => {
    const ordersBefore = await count(pool, "SELECT COUNT(*) AS c FROM orders");
    const replay = await checkout(couponBody);
    eq(replay.statusCode, 200, JSON.stringify(replay.body));
    eq(replay.body.order_id, couponOrderId);
    eq(money(replay.body.total), 1061);
    eq(money(replay.body.vat_amount), 162);
    eq(money(replay.body.discount_amount), 100);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), ordersBefore, "no second order");
    eq(await stockOf(), 9, "stock not decremented twice");
    eq(await couponUses(), 1, "coupon not counted twice");

    const mismatch = await checkout({ ...couponBody, city: "Karachi" });
    eq(mismatch.statusCode, 409, JSON.stringify(mismatch.body));
    eq(mismatch.body, { error: "Checkout attempt does not match the original request" });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), ordersBefore);
  });

  await section("no coupon: tax 180, total 1179", async () => {
    const res = await checkout(checkoutBody({ items }));
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq(money(res.body.subtotal), 999);
    eq(money(res.body.discount_amount), 0);
    eq(money(res.body.vat_amount), 180);
    eq(money(res.body.total), 1179);
    eq(res.body.coupon_code, null);
    eq(money(res.body.tax_lines[0].taxable_amount), 999);
    eq(await stockOf(), 8);
    eq(await couponUses(), 1, "coupon untouched");
  });

  await section("insufficient stock: 409 and nothing is left behind", async () => {
    const ordersBefore = await count(pool, "SELECT COUNT(*) AS c FROM orders");
    const attemptsBefore = await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts");
    const res = await checkout(checkoutBody({ items: [{ id: product.id, qty: 99 }], coupon_code: "WELCOME10" }));
    eq(res.statusCode, 409, JSON.stringify(res.body));
    eq(res.body, { error: "Insufficient stock for one or more products" });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), ordersBefore);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"), attemptsBefore, "claim rolled back");
    eq(await stockOf(), 8);
    eq(await couponUses(), 1);
  });

  await section("legacy products with active IS NULL are still orderable (read tolerance)", async () => {
    await pool.query(
      `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
       VALUES ('Legacy Null Active', 'legacy-null-active', 500, 'Accessories', '5', 1, 5, NULL)`
    );
    const legacy = await one(pool, "SELECT id FROM products WHERE slug = 'legacy-null-active'");
    const res = await checkout(checkoutBody({ items: [{ id: legacy.id, qty: 1 }] }));
    eq(res.statusCode, 200, JSON.stringify(res.body));
    await pool.query("UPDATE products SET active = 0 WHERE id = ?", [legacy.id]);
    const inactive = await checkout(checkoutBody({ items: [{ id: legacy.id, qty: 1 }] }));
    eq(inactive.statusCode, 400, "explicitly inactive stays unavailable");
  });

  await section("cancel restores stock and coupon use (same transaction)", async () => {
    const token = await mintAdminToken(pool);
    const stockBefore = await stockOf();
    const res = await invoke(adminOrders, {
      method: "PATCH",
      url: "/api/admin-orders",
      body: {
        order_id: couponOrderId,
        status: "cancelled",
        cancel_reason_code: "customer_cancelled",
        cancel_reason_note: "phase2 test",
      },
      ...adminReq(token),
    });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq(res.body.status, "cancelled");
    eq(await stockOf(), stockBefore + 1, "stock restored");
    eq(await couponUses(), 0, "coupon use released");
    const row = await one(pool, "SELECT status, cancel_reason FROM orders WHERE order_id = ?", [couponOrderId]);
    eq(row.status, "cancelled");
    ok(String(row.cancel_reason || "").length > 0, "reason stored");

    const again = await invoke(adminOrders, {
      method: "PATCH",
      url: "/api/admin-orders",
      body: { order_id: couponOrderId, status: "cancelled", cancel_reason_code: "customer_cancelled" },
      ...adminReq(token),
    });
    eq(again.statusCode, 200);
    eq(again.body.already_cancelled, true);
    eq(await stockOf(), stockBefore + 1, "second cancel does not restore twice");
  });
} catch (e) {
  failure = e;
} finally {
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("orders-migrations-db: FAIL", failure.message);
  process.exit(1);
}
console.log(`orders-migrations-db: OK ${sections.length} sections, ${total()} assertions`);
for (const s of sections) console.log(`  - ${s}`);
