/**
 * COD protection — DB/API integration test (real handlers, real MariaDB, schema from migrations only).
 *
 * Runs the REAL pages/api handlers in-process against sandy_mig_orders (127.0.0.1:3307):
 *   orders, checkout/otp-start, checkout/otp-verify, checkout/eligibility,
 *   admin-orders (PATCH confirm / dispatch), admin-blacklist, admin-order-protection.
 * The schema is rebuilt from migrations/0001..0007 + tax SQL (see tests/orders-test-support.mjs).
 *
 * Cases
 *   1  flags OFF: COD works, fingerprint path unchanged, protection columns NULL
 *   2  blacklist by phone only        3  by email only        4  by both
 *   5  new-customer cap               6  open COD limit
 *   7  risky + advance_only           8  risky + advance_delivery_charge (charge 200)
 *   9  OTP required (mock provider)   10 concurrent double-submit of one token
 *   11 COD confirmation before dispatch
 *   12 admin-blacklist / order-protection RBAC (real session rows: none / writer / manager / super_admin)
 *   13 masked blacklist list          14 otp-start rate limits
 *   15 logs never contain raw phone / email / token / code
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)  OTP_PROVIDER=mock  NODE_ENV=test
 * Run: node tests/cod-protect-db.test.mjs      (do not run in parallel with other orders tests: shared DB)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import util from "node:util";
import {
  adminReq,
  checkoutBody,
  count,
  createPool,
  ensureTestMasterLoginEnv,
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
const { resetOrderProtectionSettingsCache, ORDER_PROTECTION_KEYS } = await importFromRoot("lib/orderProtectionSettings.ts");
const { resetOtpProviderCache, hashToken } = await importFromRoot("lib/otp/index.ts");
const { CUSTOMER_TEXTS } = await importFromRoot("lib/customerTexts.ts");
const { normalisePhone, normaliseEmail } = await importFromRoot("lib/customerIdentity.ts");

const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const otpStartHandler = (await importFromRoot("pages/api/checkout/otp-start.ts")).default;
const otpVerifyHandler = (await importFromRoot("pages/api/checkout/otp-verify.ts")).default;
const eligibilityHandler = (await importFromRoot("pages/api/checkout/eligibility.ts")).default;
const adminOrdersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const adminBlacklistHandler = (await importFromRoot("pages/api/admin-blacklist.ts")).default;
const adminProtectionHandler = (await importFromRoot("pages/api/admin-order-protection.ts")).default;

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
async function section(name, fn) {
  try {
    await resetAll();
    await fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => __rateLimitTestUtils.clearStore();
const COD_REFUSED = { error: CUSTOMER_TEXTS.COD_NOT_AVAILABLE, code: "COD_NOT_AVAILABLE" };

/* ------------------------------------------------------------------ seed + helpers */

await pool.query(
  `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
   VALUES ('Protect A', 'protect-a', 1000, 'Accessories', 'In Stock', 0, NULL, 1),
          ('Protect B', 'protect-b', 1000, 'Accessories', '50', 1, 50, 1)`
);
const A = (await one(pool, "SELECT id FROM products WHERE slug = 'protect-a'")).id; // untracked, price 1000
const B = (await one(pool, "SELECT id FROM products WHERE slug = 'protect-b'")).id; // tracked, stock 50 (for stock assertions)
await pool.query("INSERT INTO coupons (code, type, value, minimum_order) VALUES ('WELCOME10','percentage',10,0)");

/** Cart lines: a x product A (untracked) and b x product B (tracked). */
const cart = (a = 1, b = 0) => [
  ...(a ? [{ id: A, qty: a }] : []),
  ...(b ? [{ id: B, qty: b }] : []),
];

let phoneSeq = 100;
function newCustomer() {
  phoneSeq += 1;
  const n = String(phoneSeq).padStart(7, "0");
  return {
    phone: `0333${n}`, //                         03330000101
    phoneFormatted: `+92 333 ${n}`, //            same customer, different spelling
    phoneNorm: `0333${n}`,
    email: `cust${phoneSeq}@example.test`,
    emailNorm: `cust${phoneSeq}@example.test`,
  };
}

/** Writes protection settings into site_content (the only place the app reads them from) and drops the cache. */
async function setSettings(map = {}) {
  await pool.query("DELETE FROM site_content WHERE content_key IN (?)", [[...ORDER_PROTECTION_KEYS]]);
  for (const [k, v] of Object.entries(map)) {
    await pool.query(
      "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES (?, ?, 'text', 'settings', ?)",
      [k, String(v), k]
    );
  }
  resetOrderProtectionSettingsCache();
}

async function resetAll() {
  for (const t of [
    "order_items",
    "order_tax_snapshots",
    "orders",
    "order_checkout_attempts",
    "customer_blacklist",
    "otp_challenges",
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
  await pool.query("UPDATE products SET stock_quantity = 50, stock = '50' WHERE id = ?", [B]);
  await pool.query("UPDATE coupons SET used_count = 0");
  await setSettings({});
  resetOtpProviderCache();
  clear();
}

async function snap() {
  return {
    orders: await count(pool, "SELECT COUNT(*) AS c FROM orders"),
    items: await count(pool, "SELECT COUNT(*) AS c FROM order_items"),
    attempts: await count(pool, "SELECT COUNT(*) AS c FROM order_checkout_attempts"),
    snapshots: await count(pool, "SELECT COUNT(*) AS c FROM order_tax_snapshots"),
    stockB: Number((await one(pool, "SELECT stock_quantity AS q FROM products WHERE id = ?", [B])).q),
    couponUses: Number((await one(pool, "SELECT used_count AS u FROM coupons WHERE code = 'WELCOME10'")).u),
    consumed: await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges WHERE status = 'consumed'"),
  };
}

/** Places an order through the real pages/api/orders.ts handler. */
async function place(c, overrides = {}, opts = {}) {
  clear();
  await sleep(3); // order ids are ORD-<ms>
  return invoke(ordersHandler, {
    url: "/api/orders",
    ip: opts.ip,
    body: checkoutBody({
      customer_phone: c.phone,
      customer_email: c.email,
      items: cart(1),
      payment_method: "cod",
      ...overrides,
    }),
  });
}

let ipSeq = 10;
const freshIp = () => `198.51.100.${(ipSeq += 1)}`;

/** otp-start / otp-verify through the real handlers (fresh IP each call unless told otherwise). */
async function otpStart(phone, { ip = freshIp(), keepLimits = false } = {}) {
  if (!keepLimits) clear();
  return invoke(otpStartHandler, { url: "/api/checkout/otp-start", body: { phone }, ip });
}
async function otpVerify(challengeId, code, { ip = freshIp(), keepLimits = false } = {}) {
  if (!keepLimits) clear();
  return invoke(otpVerifyHandler, { url: "/api/checkout/otp-verify", body: { challengeId, code }, ip });
}
/** start + verify with the mock code; returns the raw verification token. */
async function getToken(phone) {
  const s = await otpStart(phone);
  eq(s.statusCode, 200, JSON.stringify(s.body));
  const v = await otpVerify(s.body.challengeId, "000000");
  eq(v.statusCode, 200, JSON.stringify(v.body));
  ok(/^[0-9a-f]{64}$/.test(v.body.verificationToken), "token is 32 random bytes hex");
  return { token: v.body.verificationToken, challengeId: s.body.challengeId };
}
const challengeRow = (id) => one(pool, "SELECT * FROM otp_challenges WHERE id = ?", [id]);

let histSeq = 0;
/** Inserts n historic orders for a normalised phone (what the risk engine reads). */
async function insertHistory(phoneNorm, status, n = 1, paymentMethod = "cod") {
  for (let i = 0; i < n; i += 1) {
    histSeq += 1;
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, postcode,
                           payment_method, total, status, customer_phone_norm)
       VALUES (?, 'History', 'hist@example.test', ?, 'x', 'x', 'x', ?, 100, ?, ?)`,
      [`HIST-${histSeq}`, phoneNorm, paymentMethod, status, phoneNorm]
    );
  }
}

async function addBlacklist({ phoneNorm = null, emailNorm = null, reason = "test" } = {}) {
  await pool.query("INSERT INTO customer_blacklist (phone_norm, email_norm, reason, created_by) VALUES (?, ?, ?, 'test')", [
    phoneNorm,
    emailNorm,
    reason,
  ]);
}

const orderRow = (orderId) => one(pool, "SELECT * FROM orders WHERE order_id = ?", [orderId]);
const money = (v) => Number(Number(v).toFixed(2));

function expectCodRefused(res, before, after, label = "") {
  eq(res.statusCode, 409, `${label} ${JSON.stringify(res.body)}`);
  eq(res.body, COD_REFUSED, `${label} body`);
  eq(after, before, `${label}: zero rows in orders/order_items/attempts/snapshots, stock + coupon untouched, no token consumed`);
}

async function mintToken(role) {
  ensureTestMasterLoginEnv();
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, 1, role, `rbac-${role}`, expires]
  );
  return raw;
}

function admin(handler, token, { method = "GET", url = "/api/x", body, query = {}, headers = {} } = {}) {
  clear();
  const base = token ? adminReq(token) : { cookies: {}, headers: { origin: "http://orders.test" } };
  return invoke(handler, { method, url, body, query, cookies: base.cookies, headers: { ...base.headers, ...headers } });
}

/** Records every console.* call made while fn runs (errors rendered with util.inspect so own props like .sql show up). */
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const m of ["error", "warn", "log", "info", "debug"]) {
    saved[m] = console[m];
    console[m] = (...args) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 6 }))).join(" "));
    };
  }
  try {
    await fn();
  } finally {
    for (const m of Object.keys(saved)) console[m] = saved[m];
  }
  return lines;
}

const KEEP_FP_FIELDS = [
  "customer_name",
  "customer_email",
  "customer_phone",
  "delivery_address",
  "city",
  "postcode",
  "notes",
  "payment_method",
  "payment_reference",
  "receipt_path",
  "coupon_code",
  "destination",
  "items",
];
/** The pre-protection fingerprint recipe (HEAD): sha256 of the canonical JSON WITHOUT any protection extras. */
function legacyFingerprint(body) {
  const canonical = {
    customer_name: body.customer_name,
    customer_email: body.customer_email,
    customer_phone: body.customer_phone,
    delivery_address: body.delivery_address,
    city: body.city,
    postcode: body.postcode,
    notes: body.notes ?? "",
    payment_method: body.payment_method,
    payment_reference: body.payment_reference ?? "",
    receipt_path: body.receipt_path ?? "",
    coupon_code: body.coupon_code ? String(body.coupon_code).toUpperCase() : "",
    destination: "domestic",
    items: [...body.items].sort((x, y) => x.id - y.id).map((i) => ({ id: i.id, qty: i.qty })),
  };
  assert.deepEqual(Object.keys(canonical), KEEP_FP_FIELDS);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/* ------------------------------------------------------------------ cases */

let failure = null;
try {
  /* 1 ------------------------------------------------------------- */
  await section("1. flags OFF (no keys / explicit 0): COD succeeds, legacy fingerprint, protection columns NULL", async () => {
    const c = newCustomer();
    // no site_content keys at all
    const body = checkoutBody({ customer_phone: c.phone, customer_email: c.email, items: cart(1), payment_method: "cod" });
    clear();
    const res = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq(res.body.success, true);
    eq(money(res.body.total), 1180);
    const row = await orderRow(res.body.order_id);
    eq(row.payment_method, "cod");
    eq(row.status, "pending");
    for (const col of [
      "customer_phone_norm",
      "customer_email_norm",
      "risk_score",
      "risk_reasons",
      "otp_verified",
      "confirmation_method",
      "confirmed_at",
      "advance_amount",
      "advance_reference",
      "advance_receipt_path",
    ]) {
      eq(row[col], null, `${col} stays NULL when protection is off`);
    }
    const attempt = await one(pool, "SELECT request_fingerprint AS f FROM order_checkout_attempts WHERE idempotency_key = ?", [
      body.idempotency_key,
    ]);
    eq(attempt.f, legacyFingerprint(body), "fingerprint path unchanged (no protection extras)");

    // idempotent replay still works
    clear();
    const replay = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(replay.statusCode, 200);
    eq(replay.body.order_id, res.body.order_id);

    // explicit 0 + OTP flag on: still nothing is enforced; extras in the body are ignored and NOT fingerprinted
    await setSettings({ cod_protection_enabled: 0, cod_otp_enabled: 1, cod_max_open_per_phone: 1 });
    await addBlacklist({ phoneNorm: c.phoneNorm, emailNorm: c.emailNorm });
    const c2 = newCustomer();
    await addBlacklist({ phoneNorm: c2.phoneNorm });
    const body2 = checkoutBody({
      customer_phone: c2.phone,
      customer_email: c2.email,
      items: cart(1, 1),
      payment_method: "cod",
      verification_token: "not-a-real-token",
      advance_reference: "IGNORED",
    });
    clear();
    const r2 = await invoke(ordersHandler, { url: "/api/orders", body: body2 });
    eq(r2.statusCode, 200, `blacklisted but flag off -> existing behaviour: ${JSON.stringify(r2.body)}`);
    const a2 = await one(pool, "SELECT request_fingerprint AS f FROM order_checkout_attempts WHERE idempotency_key = ?", [
      body2.idempotency_key,
    ]);
    eq(a2.f, legacyFingerprint(body2), "extras never reach the fingerprint while off");
    const row2 = await orderRow(r2.body.order_id);
    eq(row2.customer_phone_norm, null);
    eq(row2.otp_verified, null);
    eq(row2.advance_amount, null);
    // a second open COD for the same phone is fine with flags off
    const r3 = await place(c2, { items: cart(1) });
    eq(r3.statusCode, 200, JSON.stringify(r3.body));

    // eligibility with flags off: everything allowed, no OTP
    clear();
    const elig = await invoke(eligibilityHandler, {
      url: "/api/checkout/eligibility",
      body: { phone: c.phone, email: c.email, items: cart(1) },
    });
    eq(elig.statusCode, 200, JSON.stringify(elig.body));
    eq(elig.body.codAllowed, true);
    eq(elig.body.otpRequired, false);
    eq(elig.body.allowedMethods, ["cod", "jazzcash", "easypaisa", "bank"], "all four when OFF");

    // narrowing advance_methods must NOT shrink the OFF allowedMethods set
    await setSettings({ cod_protection_enabled: 0, advance_methods: "bank" });
    clear();
    const eligNarrow = await invoke(eligibilityHandler, {
      url: "/api/checkout/eligibility",
      body: { phone: c.phone, email: c.email, items: cart(1) },
    });
    eq(eligNarrow.statusCode, 200, JSON.stringify(eligNarrow.body));
    eq(eligNarrow.body.allowedMethods, ["cod", "jazzcash", "easypaisa", "bank"], "OFF ignores advance_methods");
    await setSettings({ advance_methods: "jazzcash,easypaisa,bank" });
  });

  /* 2 / 3 / 4 ----------------------------------------------------- */
  async function blacklistCase({ byPhone, byEmail }) {
    await setSettings({ cod_protection_enabled: 1 });
    const c = newCustomer();
    await addBlacklist({ phoneNorm: byPhone ? c.phoneNorm : null, emailNorm: byEmail ? c.emailNorm : null });
    const before = await snap();

    // customer typed the phone differently; the norm still matches
    const res = await place(c, {
      customer_phone: byPhone ? c.phoneFormatted : c.phone,
      customer_email: byEmail ? c.email.toUpperCase() : c.email,
      items: cart(1, 1),
      coupon_code: "WELCOME10",
    });
    expectCodRefused(res, before, await snap(), "COD blacklisted");
    eq(before.stockB, 50);

    // eligibility agrees
    clear();
    const elig = await invoke(eligibilityHandler, {
      url: "/api/checkout/eligibility",
      body: { phone: c.phone, email: c.email, items: cart(1) },
    });
    eq(elig.statusCode, 200, JSON.stringify(elig.body));
    eq(elig.body.codAllowed, false);
    ok(!elig.body.allowedMethods.includes("cod"), "cod not offered");

    // advance methods still succeed for a blacklisted customer
    const jazz = await place(c, { payment_method: "jazzcash", items: cart(1, 1), payment_reference: "JC-1" });
    eq(jazz.statusCode, 200, JSON.stringify(jazz.body));
    const row = await orderRow(jazz.body.order_id);
    eq(row.payment_method, "jazzcash");
    eq(row.risk_score, 100);
    ok(String(row.risk_reasons).includes("BLACKLIST"), "BLACKLIST recorded");
    eq(row.customer_phone_norm, c.phoneNorm);
    eq(row.otp_verified, 0);
    eq((await snap()).stockB, 49, "allowed path still decrements tracked stock");

    // control: a customer matching neither identifier can still use COD
    const other = newCustomer();
    const control = await place(other, { items: cart(1) });
    eq(control.statusCode, 200, JSON.stringify(control.body));
    const crow = await orderRow(control.body.order_id);
    eq(crow.customer_phone_norm, other.phoneNorm);
    eq(crow.customer_email_norm, other.emailNorm);
    eq(crow.risk_score, 25, "new customer score");
  }
  await section("2. blacklist by PHONE only -> COD 409 COD_NOT_AVAILABLE, nothing persisted; jazzcash OK", () =>
    blacklistCase({ byPhone: true, byEmail: false })
  );
  await section("3. blacklist by EMAIL only -> same COD 409", () => blacklistCase({ byPhone: false, byEmail: true }));
  await section("4. blacklist by BOTH -> same COD 409", () => blacklistCase({ byPhone: true, byEmail: true }));

  /* 5 ------------------------------------------------------------- */
  await section("5. new customer over cap -> COD refused (zero rows); under / at cap allowed; delivered history exempt", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_new_customer_cap: 5000 });
    const c = newCustomer();
    const before = await snap();
    const over = await place(c, { items: cart(5, 1), coupon_code: "WELCOME10" }); // (6000 - 10%) * 1.18 = 6372
    expectCodRefused(over, before, await snap(), "over cap");

    const under = await place(c, { items: cart(1) }); // 1180
    eq(under.statusCode, 200, JSON.stringify(under.body));
    const urow = await orderRow(under.body.order_id);
    eq(urow.risk_score, 25);
    eq(urow.risk_reasons, "NEW_CUSTOMER");

    // exactly at cap is allowed (rule is total > cap)
    await setSettings({ cod_protection_enabled: 1, cod_new_customer_cap: 1180 });
    const atCap = await place(newCustomer(), { items: cart(1) });
    eq(atCap.statusCode, 200, JSON.stringify(atCap.body));

    // one rupee below the total -> refused
    await setSettings({ cod_protection_enabled: 1, cod_new_customer_cap: 1179 });
    const b2 = await snap();
    const justOver = await place(newCustomer(), { items: cart(1) });
    expectCodRefused(justOver, b2, await snap(), "cap 1179");

    // jazzcash over cap is fine; a customer with a delivered order is not "new"
    await setSettings({ cod_protection_enabled: 1, cod_new_customer_cap: 5000 });
    const jc = await place(newCustomer(), { items: cart(5), payment_method: "jazzcash" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));
    const trusted = newCustomer();
    await insertHistory(trusted.phoneNorm, "delivered", 1);
    const big = await place(trusted, { items: cart(5) });
    eq(big.statusCode, 200, JSON.stringify(big.body));
  });

  /* 6 ------------------------------------------------------------- */
  await section("6. open COD limit: second pending COD for the same phone is refused", async () => {
    await setSettings({ cod_protection_enabled: 1 }); // default max open per phone = 1
    const c = newCustomer();
    const first = await place(c, { items: cart(1) });
    eq(first.statusCode, 200, JSON.stringify(first.body));
    const row = await orderRow(first.body.order_id);
    eq(row.status, "pending");
    eq(row.customer_phone_norm, c.phoneNorm);

    const before = await snap();
    const second = await place({ ...c, phone: c.phoneFormatted }, { items: cart(1, 1), coupon_code: "WELCOME10" });
    expectCodRefused(second, before, await snap(), "second open COD");

    // other methods and other phones are unaffected
    const jc = await place(c, { items: cart(1), payment_method: "bank", payment_reference: "BK-1" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));
    const other = await place(newCustomer(), { items: cart(1) });
    eq(other.statusCode, 200, JSON.stringify(other.body));

    // closing the first order (cancelled) frees the slot
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE order_id = ?", [first.body.order_id]);
    const again = await place(c, { items: cart(1) });
    eq(again.statusCode, 200, JSON.stringify(again.body));

    // the limit is configurable
    await setSettings({ cod_protection_enabled: 1, cod_max_open_per_phone: 2 });
    const d = newCustomer();
    eq((await place(d, { items: cart(1) })).statusCode, 200);
    eq((await place(d, { items: cart(1) })).statusCode, 200);
    const b3 = await snap();
    expectCodRefused(await place(d, { items: cart(1) }), b3, await snap(), "third open COD with limit 2");
  });

  /* 6b D34 -------------------------------------------------------- */
  await section("6b. D34 open COD = pending|confirmed: confirmed blocks; dispatched/delivered/cancelled do not", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_max_open_per_phone: 1 });

    // confirmed (not dispatched) COD counts as open -> second COD refused
    const confCust = newCustomer();
    await insertHistory(confCust.phoneNorm, "confirmed", 1, "cod");
    const bConf = await snap();
    expectCodRefused(await place(confCust, { items: cart(1) }), bConf, await snap(), "confirmed COD is open");

    // non-COD confirmed does not count
    const confJc = newCustomer();
    await insertHistory(confJc.phoneNorm, "confirmed", 1, "jazzcash");
    eq((await place(confJc, { items: cart(1) })).statusCode, 200, "confirmed jazzcash is not open COD");

    // dispatched / delivered / cancelled COD free the slot
    for (const status of ["dispatched", "delivered", "cancelled"]) {
      const c = newCustomer();
      await insertHistory(c.phoneNorm, status, 1, "cod");
      const res = await place(c, { items: cart(1) });
      eq(res.statusCode, 200, `${status} COD must not count as open: ${JSON.stringify(res.body)}`);
    }
  });

  /* 7 ------------------------------------------------------------- */
  await section("7. risky + advance_only: cancelled history pushes risk >= threshold -> COD refused", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_risky_mode: "advance_only" });
    const risky = newCustomer();
    await insertHistory(risky.phoneNorm, "cancelled", 3); // 25 (new) + 30 = 55 >= 50
    const before = await snap();
    const res = await place(risky, { items: cart(1, 1), coupon_code: "WELCOME10" });
    expectCodRefused(res, before, await snap(), "risky");

    // advance method still allowed and records the risk
    const jc = await place(risky, { payment_method: "jazzcash", items: cart(1), payment_reference: "JC-9" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));
    const row = await orderRow(jc.body.order_id);
    eq(row.risk_score, 55);
    ok(String(row.risk_reasons).includes("CANCEL_HISTORY"));
    ok(String(row.risk_reasons).includes("RISKY_THRESHOLD"));

    // two cancellations (45) stay under the default threshold of 50
    const mild = newCustomer();
    await insertHistory(mild.phoneNorm, "cancelled", 2);
    const okRes = await place(mild, { items: cart(1) });
    eq(okRes.statusCode, 200, JSON.stringify(okRes.body));
    eq((await orderRow(okRes.body.order_id)).risk_score, 45);

    // lowering the threshold makes the same history risky
    await setSettings({ cod_protection_enabled: 1, cod_risky_mode: "advance_only", cod_risk_threshold: 40 });
    const mild2 = newCustomer();
    await insertHistory(mild2.phoneNorm, "cancelled", 2);
    const b2 = await snap();
    expectCodRefused(await place(mild2, { items: cart(1) }), b2, await snap(), "threshold 40");

    // advance_only ignores any advance reference sent along
    const b3 = await snap();
    expectCodRefused(await place(risky, { items: cart(1), advance_reference: "PAID-1" }), b3, await snap(), "advance_only + ref");
  });

  /* 8 ------------------------------------------------------------- */
  await section("8. risky + advance_delivery_charge(200): COD only with advance_reference; amount stored; total unchanged", async () => {
    await setSettings({
      cod_protection_enabled: 1,
      cod_risky_mode: "advance_delivery_charge",
      cod_advance_delivery_charge: 200,
    });
    const risky = newCustomer();
    await insertHistory(risky.phoneNorm, "cancelled", 3);

    // control total from a clean customer with the same cart
    const clean = await place(newCustomer(), { items: cart(1) });
    eq(clean.statusCode, 200, JSON.stringify(clean.body));
    const cleanTotal = money(clean.body.total);
    eq(cleanTotal, 1180);
    const cleanRow = await orderRow(clean.body.order_id);
    eq(cleanRow.advance_amount, null, "no advance for a non-risky order");

    // no reference / blank reference -> refused, nothing persisted
    const before = await snap();
    expectCodRefused(await place(risky, { items: cart(1, 1) }), before, await snap(), "no ref");
    expectCodRefused(
      await place(risky, { items: cart(1, 1), advance_reference: "   " }),
      before,
      await snap(),
      "blank ref"
    );

    // eligibility advertises the charge
    clear();
    const elig = await invoke(eligibilityHandler, {
      url: "/api/checkout/eligibility",
      body: { phone: risky.phone, email: risky.email, items: cart(1) },
    });
    eq(elig.statusCode, 200, JSON.stringify(elig.body));
    eq(elig.body.codAllowed, true);
    eq(elig.body.advanceDeliveryCharge, 200);

    // with a reference -> accepted, advance stored, order total NOT increased by the charge
    const receipt = "/uploads/receipts/123e4567-e89b-42d3-a456-426614174000.jpg";
    const body = checkoutBody({
      customer_phone: risky.phone,
      customer_email: risky.email,
      items: cart(1),
      payment_method: "cod",
      advance_reference: "ADV-REF-1",
      advance_receipt_path: receipt,
    });
    clear();
    await sleep(3);
    const okRes = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(okRes.statusCode, 200, JSON.stringify(okRes.body));
    eq(money(okRes.body.total), cleanTotal, "response total unchanged by the delivery charge");
    const row = await orderRow(okRes.body.order_id);
    eq(money(row.total), cleanTotal, "stored total unchanged by the delivery charge");
    eq(money(row.advance_amount), 200);
    eq(row.advance_reference, "ADV-REF-1");
    eq(row.advance_receipt_path, receipt);
    eq(row.payment_method, "cod");
    eq(row.otp_verified, 0);

    // protection extras ARE part of the fingerprint when on: same key + other reference conflicts, same body replays
    clear();
    const replay = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(replay.statusCode, 200);
    eq(replay.body.order_id, okRes.body.order_id);
    clear();
    const conflict = await invoke(ordersHandler, { url: "/api/orders", body: { ...body, advance_reference: "ADV-REF-2" } });
    eq(conflict.statusCode, 409, JSON.stringify(conflict.body));

    // over-cap new customer can also use COD + delivery charge
    const big = newCustomer();
    const bigRes = await place(big, { items: cart(5), advance_reference: "ADV-BIG" });
    eq(bigRes.statusCode, 200, JSON.stringify(bigRes.body));
    eq(money((await orderRow(bigRes.body.order_id)).advance_amount), 200);

    // advance methods never record an advance charge
    const jc = await place(risky, { items: cart(1), payment_method: "jazzcash", advance_reference: "X" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));
    eq((await orderRow(jc.body.order_id)).advance_amount, null);

    // a charge of 0 makes the mode unusable -> refused even with a reference
    await setSettings({
      cod_protection_enabled: 1,
      cod_risky_mode: "advance_delivery_charge",
      cod_advance_delivery_charge: 0,
    });
    const zero = newCustomer();
    await insertHistory(zero.phoneNorm, "cancelled", 3);
    const b2 = await snap();
    expectCodRefused(await place(zero, { items: cart(1), advance_reference: "ADV-0" }), b2, await snap(), "charge 0");
  });

  /* 9 ------------------------------------------------------------- */
  await section("9. OTP required (mock): no token / wrong code lockout / expired / success / reuse / other phone", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_otp_enabled: 1, cod_max_open_per_phone: 10 });

    // a. COD without (or with a junk) token is refused
    const c = newCustomer();
    let before = await snap();
    expectCodRefused(await place(c, { items: cart(1, 1) }), before, await snap(), "no token");
    expectCodRefused(await place(c, { items: cart(1, 1), verification_token: "zz" }), before, await snap(), "junk token");
    expectCodRefused(
      await place(c, { items: cart(1, 1), verification_token: "a".repeat(64) }),
      before,
      await snap(),
      "unknown token"
    );
    // eligibility says OTP is required
    clear();
    const elig = await invoke(eligibilityHandler, {
      url: "/api/checkout/eligibility",
      body: { phone: c.phone, email: c.email, items: cart(1) },
    });
    eq(elig.body.otpRequired, true);
    // advance methods do not need an OTP
    const jc = await place(c, { payment_method: "jazzcash", payment_reference: "JC-OTP" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));

    // b. wrong code x5 -> LOCKED; the correct code afterwards cannot recover the challenge
    const lock = await otpStart(c.phone);
    eq(lock.statusCode, 200, JSON.stringify(lock.body));
    ok(lock.body.challengeId && lock.body.expiresInSec > 0);
    const ch = lock.body.challengeId;
    for (let i = 1; i <= 4; i += 1) {
      const w = await otpVerify(ch, "111111", { keepLimits: i > 1 });
      eq(w.statusCode, 400, `wrong #${i} ${JSON.stringify(w.body)}`);
      eq(w.body, { error: CUSTOMER_TEXTS.COD_OTP_INVALID });
    }
    const fifth = await otpVerify(ch, "111111", { keepLimits: true });
    eq(fifth.statusCode, 429, JSON.stringify(fifth.body));
    eq(fifth.body, { error: CUSTOMER_TEXTS.COD_OTP_LOCKED });
    let row = await challengeRow(ch);
    eq(row.status, "failed");
    eq(Number(row.attempts), 5);
    const afterLock = await otpVerify(ch, "000000", { keepLimits: true });
    eq(afterLock.statusCode, 429, JSON.stringify(afterLock.body));
    eq(afterLock.body.verificationToken, undefined, "no token once locked");
    eq((await challengeRow(ch)).verification_token_hash, null);

    // c. expired challenge
    const exp = await otpStart(c.phone);
    eq(exp.statusCode, 200, JSON.stringify(exp.body));
    await pool.query("UPDATE otp_challenges SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [exp.body.challengeId]);
    const expRes = await otpVerify(exp.body.challengeId, "000000");
    eq(expRes.statusCode, 409, JSON.stringify(expRes.body));
    eq(expRes.body, { error: CUSTOMER_TEXTS.COD_OTP_EXPIRED });
    eq((await challengeRow(exp.body.challengeId)).status, "expired");
    // ... and a now-expired challenge stays expired for later attempts
    const expAgain = await otpVerify(exp.body.challengeId, "000000");
    eq(expAgain.statusCode, 409);

    // unknown / malformed
    const unk = await otpVerify(crypto.randomUUID(), "000000");
    eq(unk.statusCode, 404, JSON.stringify(unk.body));
    const bad = await otpVerify("not-a-uuid", "000000");
    eq(bad.statusCode, 400);

    // d. success: verify, then place the order with the token
    const good = newCustomer();
    const { token, challengeId } = await getToken(good.phone);
    row = await challengeRow(challengeId);
    eq(row.status, "verified");
    eq(row.verification_token_hash, hashToken(token), "only the hash is stored");
    ok(!JSON.stringify(row).includes(token), "raw token is nowhere in the challenge row");
    before = await snap();
    const placed = await place(good, { items: cart(1, 1), verification_token: token });
    eq(placed.statusCode, 200, JSON.stringify(placed.body));
    const orow = await orderRow(placed.body.order_id);
    eq(orow.otp_verified, 1);
    eq(orow.customer_phone_norm, good.phoneNorm);
    row = await challengeRow(challengeId);
    eq(row.status, "consumed");
    eq(row.consumed_order_id, placed.body.order_id);
    ok(row.consumed_at, "consumed_at stamped");
    const afterOk = await snap();
    eq(afterOk.orders, before.orders + 1);
    eq(afterOk.stockB, before.stockB - 1);
    eq(afterOk.consumed, before.consumed + 1);

    // e. token reuse on a second order is refused (nothing persisted, token stays consumed)
    before = await snap();
    expectCodRefused(await place(good, { items: cart(1, 1), verification_token: token }), before, await snap(), "token reuse");

    // f. expired token
    const ex2 = newCustomer();
    const t2 = await getToken(ex2.phone);
    await pool.query("UPDATE otp_challenges SET token_expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [t2.challengeId]);
    before = await snap();
    expectCodRefused(await place(ex2, { items: cart(1, 1), verification_token: t2.token }), before, await snap(), "expired token");
    eq((await challengeRow(t2.challengeId)).status, "verified", "expired token is not consumed");

    // g. a token minted for another phone is refused, and is NOT burnt by the refusal
    const owner = newCustomer();
    const thief = newCustomer();
    const t3 = await getToken(owner.phone);
    before = await snap();
    expectCodRefused(await place(thief, { items: cart(1, 1), verification_token: t3.token }), before, await snap(), "other phone");
    eq((await challengeRow(t3.challengeId)).status, "verified", "token survives a wrong-phone attempt");
    // advance method with that token does not consume it either
    const jc3 = await place(thief, { payment_method: "easypaisa", payment_reference: "EP-1", verification_token: t3.token });
    eq(jc3.statusCode, 200, JSON.stringify(jc3.body));
    eq((await challengeRow(t3.challengeId)).status, "verified", "non-COD order never consumes a token");
    // the rightful phone (typed another way) can still use it
    const rightful = await place({ ...owner, phone: owner.phoneFormatted }, { items: cart(1), verification_token: t3.token });
    eq(rightful.statusCode, 200, JSON.stringify(rightful.body));
    eq((await challengeRow(t3.challengeId)).status, "consumed");
  });

  /* 10 ------------------------------------------------------------ */
  await section("10. concurrent double-submit with ONE token: exactly one order consumes it", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_otp_enabled: 1, cod_max_open_per_phone: 10 });
    for (let round = 1; round <= 4; round += 1) {
      const c = newCustomer();
      const { token, challengeId } = await getToken(c.phone);
      const before = await snap();
      clear();
      const mk = () =>
        invoke(ordersHandler, {
          url: "/api/orders",
          body: checkoutBody({
            customer_phone: c.phone,
            customer_email: c.email,
            items: cart(1, 1),
            payment_method: "cod",
            verification_token: token, // two different idempotency keys, same token
          }),
        });
      const results = await Promise.all([mk(), mk()]);
      const statuses = results.map((r) => r.statusCode).sort();
      eq(statuses, [200, 409], `round ${round}: ${JSON.stringify(results.map((r) => r.body))}`);
      const loser = results.find((r) => r.statusCode === 409);
      eq(loser.body, COD_REFUSED);
      const after = await snap();
      eq(after.orders, before.orders + 1, "one order");
      eq(after.items, before.items + 2, "one order's item rows only (A + B)");
      eq(after.attempts, before.attempts + 1, "the losing attempt claim rolled back");
      eq(after.stockB, before.stockB - 1, "stock decremented once");
      eq(after.consumed, before.consumed + 1, "token consumed once");
      const winner = results.find((r) => r.statusCode === 200);
      const ch = await challengeRow(challengeId);
      eq(ch.status, "consumed");
      eq(ch.consumed_order_id, winner.body.order_id);
      eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE customer_phone_norm = ?", [c.phoneNorm]), 1);
    }
  });

  /* 11 ------------------------------------------------------------ */
  await section("11. confirmation: COD needs confirm before dispatch; call|whatsapp; non-COD unaffected", async () => {
    await setSettings({ cod_protection_enabled: 1 });
    const token = await mintToken("super_admin");
    const patch = (body) => admin(adminOrdersHandler, token, { method: "PATCH", url: "/api/admin-orders", body });
    const status = async (id) => (await orderRow(id)).status;

    const c = newCustomer();
    const cod = await place(c, { items: cart(1) });
    eq(cod.statusCode, 200, JSON.stringify(cod.body));
    const id = cod.body.order_id;

    // pending -> dispatched refused
    const d1 = await patch({ order_id: id, status: "dispatched" });
    eq(d1.statusCode, 409, JSON.stringify(d1.body));
    eq(d1.body.code, "COD_CONFIRMATION_REQUIRED");
    eq(await status(id), "pending");

    // confirm needs a valid method
    const noMethod = await patch({ order_id: id, status: "confirmed" });
    eq(noMethod.statusCode, 400, JSON.stringify(noMethod.body));
    const badMethod = await patch({ order_id: id, status: "confirmed", confirmation_method: "sms" });
    eq(badMethod.statusCode, 400);
    eq(await status(id), "pending");

    // confirm by call
    const conf = await patch({ order_id: id, status: "confirmed", confirmation_method: "call", confirmation_note: "spoke to customer" });
    eq(conf.statusCode, 200, JSON.stringify(conf.body));
    eq(conf.body.status, "confirmed");
    const row = await orderRow(id);
    eq(row.status, "confirmed");
    eq(row.confirmation_method, "call");
    eq(row.confirmation_note, "spoke to customer");
    eq(row.confirmed_by, "rbac-super_admin", "confirmed_by is the acting admin");
    ok(row.confirmed_at, "confirmed_at stamped");

    // admin detail exposes the confirmation
    const detail = await admin(adminOrdersHandler, token, { method: "GET", url: "/api/admin-orders", query: { id } });
    eq(detail.statusCode, 200);
    eq(detail.body.order.confirmation_method, "call");
    eq(detail.body.order.risk_score, 25);

    // then dispatch OK
    const d2 = await patch({ order_id: id, status: "dispatched" });
    eq(d2.statusCode, 200, JSON.stringify(d2.body));
    eq(await status(id), "dispatched");

    // whatsapp works too
    const c2 = newCustomer();
    const cod2 = await place(c2, { items: cart(1) });
    const conf2 = await patch({ order_id: cod2.body.order_id, status: "confirmed", confirmation_method: "whatsapp" });
    eq(conf2.statusCode, 200, JSON.stringify(conf2.body));
    eq((await orderRow(cod2.body.order_id)).confirmation_method, "whatsapp");
    eq((await patch({ order_id: cod2.body.order_id, status: "dispatched" })).statusCode, 200);

    // unknown order and cancelled order
    eq((await patch({ order_id: "ORD-NOPE", status: "confirmed", confirmation_method: "call" })).statusCode, 404);
    const c3 = newCustomer();
    const cod3 = await place(c3, { items: cart(1) });
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE order_id = ?", [cod3.body.order_id]);
    eq((await patch({ order_id: cod3.body.order_id, status: "confirmed", confirmation_method: "call" })).statusCode, 409);

    // non-COD status changes are unaffected (no confirmation needed)
    const jc = await place(newCustomer(), { payment_method: "jazzcash", payment_reference: "JC-11" });
    eq(jc.statusCode, 200, JSON.stringify(jc.body));
    const jd = await patch({ order_id: jc.body.order_id, status: "dispatched" });
    eq(jd.statusCode, 200, JSON.stringify(jd.body));
    eq(await status(jc.body.order_id), "dispatched");
    const jc2 = await place(newCustomer(), { payment_method: "bank", payment_reference: "BK-11" });
    eq((await patch({ order_id: jc2.body.order_id, status: "confirmed" })).statusCode, 200, "non-COD confirm needs no method");

    // protection OFF: existing behaviour, COD pending -> dispatched is allowed
    await setSettings({});
    const off = await place(newCustomer(), { items: cart(1) });
    eq(off.statusCode, 200);
    const offD = await patch({ order_id: off.body.order_id, status: "dispatched" });
    eq(offD.statusCode, 200, JSON.stringify(offD.body));
  });

  /* 12 ------------------------------------------------------------ */
  await section("12. RBAC (real sessions): admin-blacklist needs customers:block; order-protection needs super_admin", async () => {
    const tokens = {
      writer: await mintToken("writer"),
      manager: await mintToken("manager"),
      super_admin: await mintToken("super_admin"),
    };
    const c = newCustomer();
    const rowCount = () => count(pool, "SELECT COUNT(*) AS c FROM customer_blacklist");

    // seed one entry (as super_admin) to PATCH/DELETE against
    const seeded = await admin(adminBlacklistHandler, tokens.super_admin, {
      method: "POST",
      url: "/api/admin-blacklist",
      body: { phone: c.phone, reason: "seed" },
    });
    eq(seeded.statusCode, 200, JSON.stringify(seeded.body));
    const seedId = seeded.body.id;
    eq(seeded.body.phone_norm, c.phoneNorm);
    eq((await one(pool, "SELECT created_by FROM customer_blacklist WHERE id = ?", [seedId])).created_by, "rbac-super_admin");

    const calls = {
      GET: { method: "GET", query: {} },
      POST: { method: "POST", body: { phone: newCustomer().phone, reason: "rbac" } },
      PATCH: { method: "PATCH", body: { id: seedId, removed_reason: "rbac" } },
      DELETE: { method: "DELETE", body: { id: seedId, removed_reason: "rbac" } },
    };

    // no session -> 401, writer -> 403 (generic body), and nothing changes
    for (const [m, spec] of Object.entries(calls)) {
      const before = await rowCount();
      const none = await admin(adminBlacklistHandler, null, { ...spec, url: "/api/admin-blacklist" });
      eq(none.statusCode, 401, `${m} without session ${JSON.stringify(none.body)}`);
      const w = await admin(adminBlacklistHandler, tokens.writer, { ...spec, url: "/api/admin-blacklist" });
      eq(w.statusCode, 403, `${m} as writer ${JSON.stringify(w.body)}`);
      eq(w.body, { error: "Forbidden" });
      eq(await rowCount(), before, `${m} as writer / anonymous changed nothing`);
    }
    eq(Number((await one(pool, "SELECT active FROM customer_blacklist WHERE id = ?", [seedId])).active), 1, "entry still active");

    // manager and super_admin may use it
    for (const role of ["manager", "super_admin"]) {
      const created = await admin(adminBlacklistHandler, tokens[role], {
        method: "POST",
        url: "/api/admin-blacklist",
        body: { email: `${role}.rbac@example.test`, reason: `by ${role}` },
      });
      eq(created.statusCode, 200, `${role} POST ${JSON.stringify(created.body)}`);
      eq((await one(pool, "SELECT created_by FROM customer_blacklist WHERE id = ?", [created.body.id])).created_by, `rbac-${role}`);
      const list = await admin(adminBlacklistHandler, tokens[role], { method: "GET", url: "/api/admin-blacklist" });
      eq(list.statusCode, 200, `${role} GET`);
      const removed = await admin(adminBlacklistHandler, tokens[role], {
        method: "PATCH",
        url: "/api/admin-blacklist",
        body: { id: created.body.id, removed_reason: "cleanup" },
      });
      eq(removed.statusCode, 200, `${role} PATCH ${JSON.stringify(removed.body)}`);
      const rr = await one(pool, "SELECT active, removed_by, removed_reason FROM customer_blacklist WHERE id = ?", [created.body.id]);
      eq(Number(rr.active), 0);
      eq(rr.removed_by, `rbac-${role}`);
    }
    // validation still applies
    eq((await admin(adminBlacklistHandler, tokens.manager, { method: "POST", url: "/api/admin-blacklist", body: {} })).statusCode, 400);
    eq(
      (await admin(adminBlacklistHandler, tokens.manager, { method: "POST", url: "/api/admin-blacklist", body: { reason: "x" } })).statusCode,
      400,
      "phone or email required"
    );
    // cross-origin write is refused before anything runs
    const before = await rowCount();
    const xo = await admin(adminBlacklistHandler, tokens.super_admin, {
      method: "POST",
      url: "/api/admin-blacklist",
      body: { phone: newCustomer().phone, reason: "xo" },
      headers: { origin: "http://evil.test" },
    });
    eq(xo.statusCode, 403);
    eq(await rowCount(), before);

    // a blacklist entry created by an admin takes effect at checkout
    await setSettings({ cod_protection_enabled: 1 });
    const b2 = await snap();
    expectCodRefused(await place(c, { items: cart(1, 1) }), b2, await snap(), "admin-created blacklist entry");
    // ... and removing it lifts the block
    const lift = await admin(adminBlacklistHandler, tokens.manager, {
      method: "PATCH",
      url: "/api/admin-blacklist",
      body: { id: seedId, removed_reason: "forgiven" },
    });
    eq(lift.statusCode, 200);
    eq((await place(c, { items: cart(1) })).statusCode, 200);

    // order-protection settings read: super_admin only
    for (const role of ["writer", "manager"]) {
      const r = await admin(adminProtectionHandler, tokens[role], { method: "GET", url: "/api/admin-order-protection" });
      eq(r.statusCode, 403, `${role} order-protection`);
    }
    eq((await admin(adminProtectionHandler, null, { method: "GET", url: "/api/admin-order-protection" })).statusCode, 401);
    const sa = await admin(adminProtectionHandler, tokens.super_admin, { method: "GET", url: "/api/admin-order-protection" });
    eq(sa.statusCode, 200, JSON.stringify(sa.body));
    eq(sa.body.settings.cod_protection_enabled, true);
    eq(sa.body.otpProviderConfigured, true);
    ok(!JSON.stringify(sa.body).includes("mock"), "provider name is never exposed");
  });

  /* 13 ------------------------------------------------------------ */
  await section("13. GET admin-blacklist list is masked (phone_masked / email_masked, never raw norms)", async () => {
    const token = await mintToken("super_admin");
    const post = (body) => admin(adminBlacklistHandler, token, { method: "POST", url: "/api/admin-blacklist", body });
    const p1 = "03331234567";
    const e1 = "zohaib.secret@example.test";
    const p2 = "03449876543";
    const e2 = "someone.private@mail.example.test";
    eq((await post({ phone: p1, reason: "phone only" })).statusCode, 200);
    eq((await post({ email: e1, reason: "email only" })).statusCode, 200);
    eq((await post({ phone: p2, email: e2, reason: "both" })).statusCode, 200);
    eq((await post({ phone: "+14155552671", reason: "non-PK number" })).statusCode, 200);

    const list = await admin(adminBlacklistHandler, token, { method: "GET", url: "/api/admin-blacklist" });
    eq(list.statusCode, 200, JSON.stringify(list.body));
    eq(list.body.total, 4);
    eq(list.body.entries.length, 4);
    const text = JSON.stringify(list.body);
    for (const raw of [p1, e1, p2, e2, "14155552671", "zohaib.secret", "someone.private", "4155552671"]) {
      ok(!text.includes(raw), `raw value ${raw.slice(0, 4)}… absent from list response`);
    }
    for (const e of list.body.entries) {
      ok(!("phone_norm" in e) && !("email_norm" in e), "no raw norm keys");
      ok("phone_masked" in e && "email_masked" in e, "masked keys present");
      if (e.phone_masked !== null) ok(/^.{2}\*\*\*.{2}$/.test(e.phone_masked), `phone mask shape ${e.phone_masked}`);
      if (e.email_masked !== null) ok(/^.\*\*\*@.+$/.test(e.email_masked), `email mask shape ${e.email_masked}`);
    }
    const both = list.body.entries.find((e) => e.reason === "both");
    eq(both.phone_masked, "03***43");
    eq(both.email_masked, "s***@mail.example.test");
    eq(both.active, true);
    const phoneOnly = list.body.entries.find((e) => e.reason === "phone only");
    eq(phoneOnly.email_masked, null);
    eq(phoneOnly.phone_masked, "03***67");

    // searching by the raw value works but the response is still masked
    const q = await admin(adminBlacklistHandler, token, { method: "GET", url: "/api/admin-blacklist", query: { q: p2 } });
    eq(q.statusCode, 200);
    eq(q.body.total, 1);
    ok(!JSON.stringify(q.body).includes(p2));

    // removed entries (active=0 view) are masked too
    const id = list.body.entries[0].id;
    eq(
      (await admin(adminBlacklistHandler, token, { method: "PATCH", url: "/api/admin-blacklist", body: { id, removed_reason: "gone" } })).statusCode,
      200
    );
    const all = await admin(adminBlacklistHandler, token, { method: "GET", url: "/api/admin-blacklist", query: { active: "0" } });
    eq(all.body.total, 4);
    ok(!JSON.stringify(all.body).includes("example.test") || JSON.stringify(all.body).includes("***@"), "only masked emails");
    ok(!JSON.stringify(all.body).includes(p1));
    eq(all.body.entries.filter((e) => e.active === false).length, 1);
  });

  /* 14 ------------------------------------------------------------ */
  await section("14. otp-start rate limits: 4th request for one phone -> 429; IP cap; gated by the OTP flag", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_otp_enabled: 1 });
    clear();
    const c = newCustomer();
    for (let i = 1; i <= 3; i += 1) {
      const r = await otpStart(c.phone, { keepLimits: true, ip: freshIp() });
      eq(r.statusCode, 200, `request ${i}: ${JSON.stringify(r.body)}`);
    }
    const fourth = await otpStart(c.phoneFormatted, { keepLimits: true, ip: freshIp() }); // same norm, other spelling
    eq(fourth.statusCode, 429, JSON.stringify(fourth.body));
    eq(fourth.body, { error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges WHERE phone_norm = ?", [c.phoneNorm]), 3, "no 4th challenge created");
    // another phone is unaffected
    const other = await otpStart(newCustomer().phone, { keepLimits: true, ip: freshIp() });
    eq(other.statusCode, 200);

    // per-IP cap: 10 per window, 11th refused
    clear();
    const ip = "192.0.2.77";
    for (let i = 1; i <= 10; i += 1) {
      const r = await otpStart(newCustomer().phone, { keepLimits: true, ip });
      eq(r.statusCode, 200, `ip request ${i}: ${JSON.stringify(r.body)}`);
    }
    const eleventh = await otpStart(newCustomer().phone, { keepLimits: true, ip });
    eq(eleventh.statusCode, 429, JSON.stringify(eleventh.body));

    // invalid phone -> 400 and no challenge
    const rows = await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges");
    const inv = await otpStart("12", {});
    eq(inv.statusCode, 400);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), rows);

    // OTP flag off -> refused with the generic send-failed text, nothing created
    await setSettings({ cod_protection_enabled: 1, cod_otp_enabled: 0 });
    const off = await otpStart(newCustomer().phone, {});
    eq(off.statusCode, 409, JSON.stringify(off.body));
    eq(off.body, { error: CUSTOMER_TEXTS.COD_OTP_SEND_FAILED });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), rows);
  });

  /* 15 ------------------------------------------------------------ */
  await section("15. logs: failed OTP / refusal paths never print raw phone, email, token or code", async () => {
    await setSettings({ cod_protection_enabled: 1, cod_otp_enabled: 1, cod_max_open_per_phone: 10 });
    const c = {
      phone: "03339876543",
      phoneFormatted: "+92 333 9876543",
      phoneNorm: "03339876543",
      email: "log.leak.check@example.test",
      emailNorm: "log.leak.check@example.test",
    };
    const tokens = [];
    const lines = await captureConsole(async () => {
      // wrong-code lockout + expired + unknown
      const s = await otpStart(c.phone);
      for (let i = 0; i < 5; i += 1) await otpVerify(s.body.challengeId, "111111", { keepLimits: i > 0 });
      await otpVerify(s.body.challengeId, "000000", { keepLimits: true });
      await otpVerify(crypto.randomUUID(), "111111");

      // token paths: refused without token, wrong phone, reuse
      const t = await getToken(c.phone);
      tokens.push(t.token);
      await place({ ...c, phone: "03331112223", phoneFormatted: "x", email: "someone.else@example.test" }, { items: cart(1), verification_token: t.token });
      const okOrder = await place(c, { items: cart(1), verification_token: t.token });
      eq(okOrder.statusCode, 200);
      await place(c, { items: cart(1), verification_token: t.token }); // reuse
      await place(c, { items: cart(1) }); // no token

      // blacklist refusal
      const bl = { ...c, phone: "03335550001", email: "blocked.person@example.test" };
      await addBlacklist({ phoneNorm: bl.phone, emailNorm: "blocked.person@example.test" });
      await place(bl, { items: cart(1) });

      // infrastructure failure on the OTP path: table missing -> handlers log, must not echo identifiers
      const t2 = await getToken(c.phone);
      tokens.push(t2.token);
      await pool.query("RENAME TABLE otp_challenges TO otp_challenges_hidden");
      try {
        await otpStart(c.phone);
        await otpVerify(crypto.randomUUID(), "111111");
        await place({ ...c, phone: c.phoneFormatted }, { items: cart(1), verification_token: t2.token });
      } finally {
        await pool.query("RENAME TABLE otp_challenges_hidden TO otp_challenges");
      }

      // provider not configured -> one-shot warning
      const prevProvider = process.env.OTP_PROVIDER;
      delete process.env.OTP_PROVIDER;
      resetOtpProviderCache();
      try {
        await otpStart(c.phone);
      } finally {
        process.env.OTP_PROVIDER = prevProvider;
        resetOtpProviderCache();
      }
    });

    if (process.env.COD_TEST_DEBUG) console.log("captured log lines:\n" + lines.map((l) => "  | " + l.split("\n")[0]).join("\n"));
    ok(lines.length >= 3, "the failure paths did log something (the scan is meaningful)");
    const blob = lines.join("\n");
    const digitsOnly = blob.replace(/\D/g, "");
    const forbidden = [
      c.phone,
      c.phoneFormatted,
      "3339876543",
      "03331112223",
      "03335550001",
      c.email,
      "log.leak.check",
      "someone.else@example.test",
      "blocked.person@example.test",
      ...tokens,
    ];
    for (const f of forbidden) {
      ok(!blob.includes(f), `log output must not contain ${f.length > 12 ? f.slice(0, 6) + "…" : f}`);
    }
    ok(!digitsOnly.includes("3339876543"), "no phone digits even after stripping punctuation");
    ok(!/(?<!\d)(111111|000000)(?!\d)/.test(blob), "no OTP code values in logs");
  });
} catch (e) {
  failure = e;
} finally {
  await pool.query("DROP TABLE IF EXISTS otp_challenges_hidden").catch(() => {});
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("FAILED:", failure.message);
  if (failure.stack) console.error(failure.stack.split("\n").slice(1, 6).join("\n"));
  console.error(`passed sections: ${sections.length}`);
  process.exit(1);
}
console.log(`cod-protect-db: ${sections.length} sections, ${total()} assertions — all green`);
for (const s of sections) console.log(`  ✔ ${s}`);
