/**
 * COD protection — HEAD parity test.
 *
 * With every protection flag OFF (no site_content keys), the checkout response must have exactly the
 * shape pages/api/orders.ts returned at HEAD (before COD protection): same keys, same order, same item shape,
 * and no protection field may leak into it. Runs the REAL handler against sandy_mig_orders (127.0.0.1:3307).
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)   Run: node tests/cod-protect-parity.test.mjs
 * (shares the dedicated DB with the other orders tests: do not run in parallel)
 */
import assert from "node:assert/strict";
import {
  checkoutBody,
  createPool,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  one,
  rebuildFromMigrations,
  requirePassword,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.OTP_PROVIDER = "mock";
process.env.NODE_ENV = "test";

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetOrderProtectionSettingsCache } = await importFromRoot("lib/orderProtectionSettings.ts");
const orders = (await importFromRoot("pages/api/orders.ts")).default;
const { eq, ok, total } = makeAssertions(assert);

/** Frozen from `git show HEAD:pages/api/orders.ts` (success response, in source order). */
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
/** Frozen from HEAD buildAuthoritativeReplayResponse (idempotent replay of the same key). */
const HEAD_REPLAY_KEYS = [
  "tax_label",
  "success",
  "order_id",
  "whatsappUrl",
  "telegramUrl",
  "subtotal",
  "shipping",
  "vat_amount",
  "discount_amount",
  "total",
  "coupon_code",
  "items",
];
const HEAD_ITEM_KEYS = ["product_id", "product_name", "price", "quantity"];
const HEAD_TAX_LINE_KEYS = ["tax_class_id", "tax_class_name", "rate_percent", "taxable_amount", "tax_amount"];
/** The fields the task calls out explicitly - must be present on every flags-off success. */
const REQUIRED = ["success", "order_id", "subtotal", "shipping", "vat_amount", "total", "items"];
const PROTECTION_LEAKS = [
  "code",
  "risk_score",
  "risk_reasons",
  "otp_verified",
  "advance_amount",
  "advance_reference",
  "confirmation_method",
  "customer_phone_norm",
  "customer_email_norm",
  "verification_token",
];

let failure = null;
try {
  await pool.query(
    `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
     VALUES ('Parity A', 'parity-a', 1000, 'Accessories', 'In Stock', 0, NULL, 1)`
  );
  const productId = (await one(pool, "SELECT id FROM products WHERE slug = 'parity-a'")).id;
  await pool.query("DELETE FROM site_content WHERE content_key LIKE 'cod\\_%' OR content_key = 'advance_methods'");
  resetOrderProtectionSettingsCache();
  __rateLimitTestUtils.clearStore();

  const body = checkoutBody({
    customer_phone: "03331230000",
    customer_email: "parity@example.test",
    items: [{ id: productId, qty: 1 }],
    payment_method: "cod",
  });
  const res = await invoke(orders, { url: "/api/orders", body });

  eq(res.statusCode, 200, JSON.stringify(res.body));
  for (const k of REQUIRED) ok(k in res.body, `required key ${k}`);
  eq(Object.keys(res.body), HEAD_SUCCESS_KEYS, "success keys (and order) match HEAD");
  eq(res.body.success, true);
  ok(/^ORD-\d+$/.test(res.body.order_id));
  eq(res.body.subtotal, 1000);
  eq(res.body.shipping, 0);
  eq(res.body.vat_amount, 180);
  eq(res.body.total, 1180);
  eq(res.body.discount_amount, 0);
  eq(res.body.coupon_code, null);
  eq(res.body.items.length, 1);
  eq(Object.keys(res.body.items[0]), HEAD_ITEM_KEYS, "item keys match HEAD");
  eq(res.body.items[0], { product_id: productId, product_name: "Parity A", price: 1000, quantity: 1 });
  eq(res.body.tax_lines.length, 1);
  eq(Object.keys(res.body.tax_lines[0]), HEAD_TAX_LINE_KEYS, "tax line keys match HEAD");
  for (const k of PROTECTION_LEAKS) ok(!(k in res.body), `protection field ${k} must not appear with flags off`);

  // idempotent replay keeps the HEAD replay shape too
  __rateLimitTestUtils.clearStore();
  const replay = await invoke(orders, { url: "/api/orders", body });
  eq(replay.statusCode, 200, JSON.stringify(replay.body));
  eq(Object.keys(replay.body), HEAD_REPLAY_KEYS, "replay keys match HEAD");
  eq(replay.body.order_id, res.body.order_id);
  eq(replay.body.total, res.body.total);
  for (const k of PROTECTION_LEAKS) ok(!(k in replay.body), `protection field ${k} must not appear in replay`);

  // and the error shape for a plain validation failure is the HEAD one: { error } only
  __rateLimitTestUtils.clearStore();
  const bad = await invoke(orders, { url: "/api/orders", body: { ...body, idempotency_key: "not-a-uuid" } });
  eq(bad.statusCode, 400);
  eq(bad.body, { error: "Invalid request" });
  __rateLimitTestUtils.clearStore();
  const unavailable = await invoke(orders, {
    url: "/api/orders",
    body: checkoutBody({ items: [{ id: productId + 999, qty: 1 }], customer_phone: "03331230000", customer_email: "parity@example.test" }),
  });
  eq(unavailable.statusCode, 400);
  eq(unavailable.body, { error: "One or more products are unavailable" });
} catch (e) {
  failure = e;
} finally {
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("FAILED:", failure.message);
  if (failure.stack) console.error(failure.stack.split("\n").slice(1, 6).join("\n"));
  process.exit(1);
}
console.log(`cod-protect-parity: ${total()} assertions — all green (flags-off response shape == HEAD)`);
