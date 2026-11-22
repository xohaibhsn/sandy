/**
 * Customer accounts (SANDY-BATCH-09) — DB/API integration test (real handlers, real MariaDB, schema from migrations only).
 *
 * Runs the REAL pages/api handlers in-process against sandy_mig_orders (127.0.0.1:3307):
 *   account/{login-start,login-verify,logout,me,profile,addresses,wishlist,delete}, account/orders/{index,[orderId],claim},
 *   orders (stamp), site-content (flag write RBAC), admin-accounts-settings.
 * The schema is rebuilt from migrations/0001..0008 + tax SQL (see tests/orders-test-support.mjs).
 *
 * Sections
 *   1  flag OFF: every /api/account/* route 404; checkout works; orders.customer_id stays NULL even with a cookie
 *   2  flag ON + mock OTP: login-start -> login-verify (000000) -> cookie; me 200; logout clears; me without cookie 401
 *   3  OTP unconfigured (provider cleared / mock in production) -> 503 ACCOUNT_OTP_UNAVAILABLE
 *   4  Twilio Verify path with mocked global fetch (VerificationSid), start failure -> 500, restore
 *   5  login-verify hardening: wrong codes / lockout / reuse / wrong-purpose challenge / bad hints / disabled customer
 *   6  session rotation on re-login; revoke on logout
 *   7  orders ownership: A cannot see B; phone_norm match shows unlinked guest orders
 *   8  claim past orders by phone only
 *   9  order stamp: logged-in place order sets customer_id (guest / expired session do not)
 *   10 addresses CRUD + exactly one default
 *   11 wishlist uniqueness + active product rule
 *   12 profile update
 *   13 delete account: sessions/addresses/wishlist gone, orders kept (customer_id NULL), blacklist row kept
 *   14 rate limits smoke
 *   15 logs never contain raw phone / email / OTP code / session token
 *   16 RBAC: settings:accounts is super_admin only (site-content write + admin-accounts-settings GET)
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)  OTP_PROVIDER=mock  NODE_ENV=test
 * Run: node tests/accounts-db.test.mjs      (do not run in parallel with other orders tests: shared DB)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import util from "node:util";
import {
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
delete process.env.OTP_CHANNEL;
delete process.env.NEXT_PUBLIC_SITE_URL;
delete process.env.SITE_URL;

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetAccountSettingsCache, ACCOUNT_SETTINGS_KEYS } = await importFromRoot("lib/accountSettings.ts");
const { resetOrderProtectionSettingsCache } = await importFromRoot("lib/orderProtectionSettings.ts");
const { resetOtpProviderCache } = await importFromRoot("lib/otp/index.ts");
const { CUSTOMER_TEXTS } = await importFromRoot("lib/customerTexts.ts");
const { createCustomerSession, hashCustomerSessionToken } = await importFromRoot("lib/customerAuth.ts");

const H = {
  loginStart: (await importFromRoot("pages/api/account/login-start.ts")).default,
  loginVerify: (await importFromRoot("pages/api/account/login-verify.ts")).default,
  logout: (await importFromRoot("pages/api/account/logout.ts")).default,
  me: (await importFromRoot("pages/api/account/me.ts")).default,
  profile: (await importFromRoot("pages/api/account/profile.ts")).default,
  addresses: (await importFromRoot("pages/api/account/addresses.ts")).default,
  wishlist: (await importFromRoot("pages/api/account/wishlist.ts")).default,
  del: (await importFromRoot("pages/api/account/delete.ts")).default,
  orders: (await importFromRoot("pages/api/account/orders/index.ts")).default,
  orderDetail: (await importFromRoot("pages/api/account/orders/[orderId].ts")).default,
  claim: (await importFromRoot("pages/api/account/orders/claim.ts")).default,
};
const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const siteContentHandler = (await importFromRoot("pages/api/site-content.ts")).default;
const adminAccountsSettingsHandler = (await importFromRoot("pages/api/admin-accounts-settings.ts")).default;

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
async function section(name, fn) {
  try {
    await resetAll();
    console.log(`> ${name}`);
    await fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => __rateLimitTestUtils.clearStore();
const NOT_FOUND = { error: "Not found" };

/* ------------------------------------------------------------------ seed + helpers */

await pool.query(
  `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
   VALUES ('Acct Active', 'acct-active', 1000, 'Accessories', 'In Stock', 0, NULL, 1),
          ('Acct Active 2', 'acct-active-2', 500, 'Accessories', 'In Stock', 0, NULL, 1),
          ('Acct Inactive', 'acct-inactive', 700, 'Accessories', 'In Stock', 0, NULL, 0)`
);
const P1 = (await one(pool, "SELECT id FROM products WHERE slug = 'acct-active'")).id;
const P2 = (await one(pool, "SELECT id FROM products WHERE slug = 'acct-active-2'")).id;
const PX = (await one(pool, "SELECT id FROM products WHERE slug = 'acct-inactive'")).id;

let phoneSeq = 200;
function newPerson() {
  phoneSeq += 1;
  const n = String(phoneSeq).padStart(7, "0");
  return { phone: `0333${n}`, phoneNorm: `0333${n}`, phoneFormatted: `+92 333 ${n}`, email: `acct${phoneSeq}@example.test` };
}

let ipSeq = 20;
/** Unique, valid IPv4 per call (198.18.0.0/15) so rate-limit buckets never collide unless a test wants them to. */
const freshIp = () => {
  ipSeq += 1;
  return `198.18.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

/** Flag writer (the only place the app reads it from) + cache drop. */
async function setAccounts(value) {
  await pool.query("DELETE FROM site_content WHERE content_key IN (?)", [[...ACCOUNT_SETTINGS_KEYS]]);
  if (value !== null && value !== undefined) {
    await pool.query(
      "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES ('accounts_enabled', ?, 'text', 'settings', 'accounts_enabled')",
      [String(value)]
    );
  }
  resetAccountSettingsCache();
}

async function setProtection(map = {}) {
  await pool.query("DELETE FROM site_content WHERE content_key LIKE 'cod\\_%' OR content_key = 'advance_methods'");
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
    "customer_sessions",
    "customer_addresses",
    "customer_wishlist",
    "customers",
    "admin_sessions",
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
  await pool.query("UPDATE products SET active = 1 WHERE id IN (?, ?)", [P1, P2]);
  await pool.query("UPDATE products SET active = 0 WHERE id = ?", [PX]);
  await setAccounts(null);
  await setProtection({});
  process.env.OTP_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  resetOtpProviderCache();
  clear();
}

/** Calls an account handler. Same-origin headers are always sent (Origin + host) unless overridden. */
function call(handler, { method = "GET", body, query = {}, token, ip = freshIp(), headers = {}, keepLimits = false, cookies } = {}) {
  if (!keepLimits) clear();
  return invoke(handler, {
    method,
    url: "/api/account/x",
    body,
    query,
    ip,
    cookies: cookies ?? (token ? { sCustomerSession: token } : {}),
    headers: { host: "orders.test", origin: "http://orders.test", ...headers },
  });
}

const cookieToken = (res) => /sCustomerSession=([0-9a-f]{64})/.exec(String(res.headers["set-cookie"] || ""))?.[1] ?? null;
const customerRow = (phoneNorm) => one(pool, "SELECT * FROM customers WHERE phone_norm = ?", [phoneNorm]);

/** login-start + login-verify with the mock code through the real handlers. */
async function login(person, extra = {}) {
  const ip = freshIp();
  const s = await call(H.loginStart, { method: "POST", body: { phone: person.phone }, ip });
  eq(s.statusCode, 200, `login-start ${JSON.stringify(s.body)}`);
  const v = await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "000000", ...extra }, ip });
  eq(v.statusCode, 200, `login-verify ${JSON.stringify(v.body)}`);
  const token = cookieToken(v);
  ok(token, "session cookie issued");
  const row = await customerRow(person.phoneNorm);
  return { token, id: Number(row.id), challengeId: s.body.challengeId };
}

/** Places an order through the real checkout handler (optionally with a customer cookie). */
async function place(person, { token, items = [{ id: P1, qty: 1 }], ip = freshIp() } = {}) {
  clear();
  await sleep(3); // order ids are ORD-<ms>
  return invoke(ordersHandler, {
    url: "/api/orders",
    ip,
    cookies: token ? { sCustomerSession: token } : {},
    body: checkoutBody({ customer_phone: person.phone, customer_email: person.email, items, payment_method: "cod" }),
  });
}

let orderSeq = 0;
/** Inserts an order row directly (what a guest order looks like once phone_norm is recorded). */
async function insertOrder({ phoneNorm = null, customerId = null, email = "guest@example.test", status = "pending", items = 1 } = {}) {
  orderSeq += 1;
  const orderId = `ACC-${Date.now()}-${orderSeq}`;
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, postcode,
                         payment_method, total, status, customer_phone_norm, customer_id)
     VALUES (?, 'Seeded', ?, ?, 'House 1', 'Lahore', '54000', 'cod', 100, ?, ?, ?)`,
    [orderId, email, phoneNorm || "0000", status, phoneNorm, customerId]
  );
  for (let i = 0; i < items; i += 1) {
    await pool.query("INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?, ?, 'Acct Active', 1000, 1)", [orderId, P1]);
  }
  return orderId;
}
const orderRow = (orderId) => one(pool, "SELECT * FROM orders WHERE order_id = ?", [orderId]);

async function mintToken(role) {
  ensureTestMasterLoginEnv();
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, 1, role, `acct-${role}`, expires]
  );
  return raw;
}

function admin(handler, token, { method = "GET", url = "/api/x", body, query = {}, headers = {} } = {}) {
  clear();
  return invoke(handler, {
    method,
    url,
    body,
    query,
    cookies: token ? { sAdminSession: token } : {},
    headers: { origin: "http://orders.test", ...headers },
  });
}

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

const addr = (over = {}) => ({
  label: "Home",
  full_name: "Test Customer",
  phone: "03331234567",
  line1: "House 1, Street 2",
  city: "Lahore",
  province: "Punjab",
  postcode: "54000",
  ...over,
});
const addrRows = (customerId) =>
  pool.query("SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id", [customerId]).then(([r]) => r);
const defaults = (rows) => rows.filter((r) => Number(r.is_default) === 1).length;

let failure = null;
try {
  console.log("accounts-db");

  /* 1 ------------------------------------------------------------ */
  await section("1. flag OFF: ALL /api/account/* 404, checkout unchanged, orders.customer_id stays NULL", async () => {
    // an existing customer + live session, so a 404 can only come from the flag gate
    const p = newPerson();
    const [r] = await pool.query("INSERT INTO customers (phone_norm, name) VALUES (?, 'Existing')", [p.phoneNorm]);
    const custId = Number(r.insertId);
    const token = await createCustomerSession(custId);

    for (const flagValue of [null, "0", "garbage"]) {
      await setAccounts(flagValue);
      const routes = [
        ["login-start", H.loginStart, ["POST", "GET"], { phone: p.phone }],
        ["login-verify", H.loginVerify, ["POST", "GET"], { challengeId: crypto.randomUUID(), code: "000000" }],
        ["logout", H.logout, ["POST", "GET"], {}],
        ["me", H.me, ["GET", "POST"], undefined],
        ["profile", H.profile, ["PATCH", "GET"], { name: "X" }],
        ["addresses", H.addresses, ["GET", "POST", "PATCH", "DELETE"], addr()],
        ["wishlist", H.wishlist, ["GET", "POST", "DELETE"], { productId: P1 }],
        ["delete", H.del, ["POST", "GET"], { confirm: "DELETE" }],
        ["orders", H.orders, ["GET", "POST"], undefined],
        ["orders/[orderId]", H.orderDetail, ["GET", "POST"], undefined],
        ["orders/claim", H.claim, ["POST", "GET"], {}],
      ];
      for (const [name, handler, methods, body] of routes) {
        for (const method of methods) {
          for (const withCookie of [true, false]) {
            const res = await call(handler, { method, body, token: withCookie ? token : undefined, query: { orderId: "ORD-1", id: "1", productId: String(P1) } });
            eq(res.statusCode, 404, `${name} ${method} cookie=${withCookie} flag=${flagValue} -> ${res.statusCode}`);
            eq(res.body, NOT_FOUND, `${name} ${method} body`);
            ok(!res.headers["set-cookie"], `${name} must not set a cookie when off`);
          }
        }
        // cross-origin / no-origin requests are also 404 (flag gate runs first)
        const xo = await call(handler, { method: "POST", body, token, headers: { origin: "http://evil.test" } });
        eq(xo.statusCode, 404, `${name} cross-origin while off`);
      }
    }
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), 0, "no OTP challenge created while off");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers"), 1, "no customer created while off");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 1, "session untouched while off");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses"), 0);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist"), 0);

    // checkout still works for guests; a stray valid cookie does NOT stamp (flag off skips the stamp)
    await setAccounts("0");
    const guest = await place(newPerson());
    eq(guest.statusCode, 200, JSON.stringify(guest.body));
    eq((await orderRow(guest.body.order_id)).customer_id, null, "guest order customer_id NULL");

    const withCookie = await place(p, { token });
    eq(withCookie.statusCode, 200, JSON.stringify(withCookie.body));
    eq(Object.keys(withCookie.body).includes("customer_id"), false, "checkout response unchanged");
    eq((await orderRow(withCookie.body.order_id)).customer_id, null, "flag OFF + cookie present -> still NULL");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE customer_id IS NOT NULL"), 0);

    // flipping the flag ON makes the very same cookie stamp
    await setAccounts("1");
    const stamped = await place(p, { token });
    eq(stamped.statusCode, 200, JSON.stringify(stamped.body));
    eq(Number((await orderRow(stamped.body.order_id)).customer_id), custId, "flag ON + cookie -> stamped");
  });

  /* 2 ------------------------------------------------------------ */
  await section("2. flag ON + mock OTP: login-start -> login-verify(000000) -> cookie; me 200; logout clears; me w/o cookie 401", async () => {
    await setAccounts("1");
    const p = newPerson();

    const unauth = await call(H.me, {});
    eq(unauth.statusCode, 401, "me without cookie");
    eq(unauth.body, { error: "Unauthorized" });
    eq((await call(H.me, { token: "f".repeat(64) })).statusCode, 401, "me with unknown (well-formed) cookie");
    eq((await call(H.me, { token: "not-a-token" })).statusCode, 401, "me with malformed cookie");

    const ip = freshIp();
    const s = await call(H.loginStart, { method: "POST", body: { phone: p.phoneFormatted }, ip });
    eq(s.statusCode, 200, JSON.stringify(s.body));
    eq(Object.keys(s.body).sort(), ["challengeId", "channel", "expiresInSec"]);
    eq(s.body.channel, "sms");
    ok(/^[0-9a-f-]{36}$/.test(s.body.challengeId));
    eq(s.body.expiresInSec, 600);
    eq(s.headers["cache-control"], "no-store");
    ok(!s.headers["set-cookie"], "login-start sets no cookie");
    const ch = await one(pool, "SELECT * FROM otp_challenges WHERE id = ?", [s.body.challengeId]);
    eq(ch.purpose, "login");
    eq(ch.phone_norm, p.phoneNorm, "challenge stored under the normalised phone");
    eq(ch.status, "sent");
    eq(ch.provider, "mock");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers"), 0, "no customer before verification");

    const v = await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "000000" }, ip });
    eq(v.statusCode, 200, JSON.stringify(v.body));
    eq(v.body, { ok: true });
    eq(v.headers["cache-control"], "no-store");
    const setCookie = String(v.headers["set-cookie"]);
    const token = cookieToken(v);
    ok(token, "cookie token is 64 hex");
    for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 24 * 60 * 60}`]) ok(setCookie.includes(part), part);
    const cust = await customerRow(p.phoneNorm);
    ok(cust, "customer upserted on first verified login");
    ok(cust.last_login_at, "last_login_at set");
    eq(cust.status, "active");
    eq((await one(pool, "SELECT token_hash FROM customer_sessions WHERE customer_id = ?", [cust.id])).token_hash, hashCustomerSessionToken(token), "only the hash is stored");
    eq((await one(pool, "SELECT status FROM otp_challenges WHERE id = ?", [s.body.challengeId])).status, "verified");

    const me = await call(H.me, { token });
    eq(me.statusCode, 200, JSON.stringify(me.body));
    eq(me.body, { customer: { id: Number(cust.id), phone_norm: p.phoneNorm, name: null, email: null } });
    eq(me.headers["cache-control"], "no-store");

    // logout (needs same-origin) clears the cookie and kills the session
    const lo = await call(H.logout, { method: "POST", token });
    eq(lo.statusCode, 200);
    eq(lo.body, { ok: true });
    ok(String(lo.headers["set-cookie"]).startsWith("sCustomerSession=;") && String(lo.headers["set-cookie"]).includes("Max-Age=0"), "cookie cleared");
    eq((await call(H.me, { token })).statusCode, 401, "me after logout");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 0);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers WHERE phone_norm = ?", [p.phoneNorm]), 1, "customer record survives logout");

    // method / origin / validation guards
    eq((await call(H.loginStart, { method: "GET" })).statusCode, 405);
    eq((await call(H.loginVerify, { method: "GET" })).statusCode, 405);
    eq((await call(H.logout, { method: "GET" })).statusCode, 405);
    eq((await call(H.loginStart, { method: "POST", body: { phone: p.phone }, headers: { origin: "http://evil.test" } })).statusCode, 403, "cross-origin login-start");
    eq((await call(H.loginStart, { method: "POST", body: { phone: p.phone }, headers: { origin: undefined } })).statusCode, 403, "missing Origin/Referer");
    eq((await call(H.loginStart, { method: "POST", body: { phone: p.phone }, headers: { origin: undefined, referer: "http://orders.test/account" } })).statusCode, 200, "Referer fallback");
    eq((await call(H.loginStart, { method: "POST", body: { phone: "12" } })).statusCode, 400, "bad phone");
    eq((await call(H.loginStart, { method: "POST", body: {} })).statusCode, 400, "no phone");
    eq((await call(H.loginStart, { method: "POST", body: { phone: ["03331234567"] } })).statusCode, 400, "non-string phone");
    eq((await call(H.me, { method: "POST", token })).statusCode, 401, "POST me w/ dead token");
  });

  /* 3 ------------------------------------------------------------ */
  await section("3. flag ON + OTP unconfigured: login-start 503 ACCOUNT_OTP_UNAVAILABLE (cleared provider / mock in production)", async () => {
    await setAccounts("1");
    const p = newPerson();
    const unavailable = { error: CUSTOMER_TEXTS.ACCOUNT_OTP_UNAVAILABLE };
    const prevProvider = process.env.OTP_PROVIDER;
    const prevEnv = process.env.NODE_ENV;
    try {
      delete process.env.OTP_PROVIDER;
      resetOtpProviderCache();
      const lines = await captureConsole(async () => {
        const res = await call(H.loginStart, { method: "POST", body: { phone: p.phone } });
        eq(res.statusCode, 503, JSON.stringify(res.body));
        eq(res.body, unavailable);
        const v = await call(H.loginVerify, { method: "POST", body: { challengeId: crypto.randomUUID(), code: "000000" } });
        eq(v.statusCode, 503, "login-verify is unavailable too");
        eq(v.body, unavailable);
        ok(!v.headers["set-cookie"]);
      });
      ok(lines.some((l) => l.includes("OTP_PROVIDER_NOT_CONFIGURED")), "one-shot misconfiguration warning");
      eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), 0, "no challenge row");

      // incomplete Twilio config is also "unconfigured"
      process.env.OTP_PROVIDER = "twilio_verify";
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_VERIFY_SERVICE_SID;
      resetOtpProviderCache();
      await captureConsole(async () => {
        const tw = await call(H.loginStart, { method: "POST", body: { phone: p.phone } });
        eq(tw.statusCode, 503);
        eq(tw.body, unavailable);
      });

      // mock is refused in production
      process.env.OTP_PROVIDER = "mock";
      process.env.NODE_ENV = "production";
      resetOtpProviderCache();
      await captureConsole(async () => {
        const prod = await call(H.loginStart, { method: "POST", body: { phone: p.phone } });
        eq(prod.statusCode, 503, "mock provider refused in production");
        eq(prod.body, unavailable);
      });
    } finally {
      process.env.OTP_PROVIDER = prevProvider;
      process.env.NODE_ENV = prevEnv;
      resetOtpProviderCache();
    }
    // restored: works again
    eq((await call(H.loginStart, { method: "POST", body: { phone: p.phone } })).statusCode, 200, "mock works again after restore");
  });

  /* 4 ------------------------------------------------------------ */
  await section("4. Twilio Verify path (mocked global fetch, VerificationSid): login-start + login-verify succeed; restore", async () => {
    await setAccounts("1");
    const p = newPerson();
    const SERVICE_SID = "VA" + "b".repeat(32);
    const ACCOUNT_SID = "AC" + "c".repeat(32);
    const AUTH_TOKEN = "test-auth-token-value";
    const VE_SID = "VE" + "a".repeat(32);
    const START_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/Verifications`;
    const CHECK_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/VerificationCheck`;

    const saved = {
      fetch: globalThis.fetch,
      provider: process.env.OTP_PROVIDER,
      sid: process.env.TWILIO_ACCOUNT_SID,
      auth: process.env.TWILIO_AUTH_TOKEN,
      svc: process.env.TWILIO_VERIFY_SERVICE_SID,
      channel: process.env.OTP_CHANNEL,
    };
    const calls = [];
    let checkStatus = "approved";
    let startOk = true;
    try {
      process.env.OTP_PROVIDER = "twilio_verify";
      delete process.env.OTP_CHANNEL;
      process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
      process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
      process.env.TWILIO_VERIFY_SERVICE_SID = SERVICE_SID;
      resetOtpProviderCache();
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: String(init?.method || "GET"), body: Object.fromEntries(new URLSearchParams(String(init?.body || ""))), auth: init?.headers?.Authorization });
        if (String(url) === START_URL) {
          return startOk ? new Response(JSON.stringify({ sid: VE_SID }), { status: 201 }) : new Response("nope", { status: 500 });
        }
        if (String(url) === CHECK_URL) return new Response(JSON.stringify({ status: checkStatus }), { status: 200 });
        throw new Error("unexpected outbound fetch: " + String(url));
      };

      const ip = freshIp();
      const s = await call(H.loginStart, { method: "POST", body: { phone: p.phoneFormatted }, ip });
      eq(s.statusCode, 200, JSON.stringify(s.body));
      eq(calls.length, 1);
      eq(calls[0].url, START_URL);
      eq(calls[0].method, "POST");
      eq(calls[0].body, { To: "+92" + p.phoneNorm.slice(1), Channel: "sms" }, "To is E.164, SMS channel by default");
      ok(String(calls[0].auth).startsWith("Basic "), "Basic auth header shape");
      const ch = await one(pool, "SELECT provider, provider_ref, purpose, status FROM otp_challenges WHERE id = ?", [s.body.challengeId]);
      eq(ch, { provider: "twilio_verify", provider_ref: VE_SID, purpose: "login", status: "sent" });

      // wrong code (Twilio says pending) -> 400 invalid, no session
      checkStatus = "pending";
      const bad = await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "123456" }, ip });
      eq(bad.statusCode, 400);
      eq(bad.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
      ok(!bad.headers["set-cookie"]);
      eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 0);

      checkStatus = "approved";
      const v = await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "123456" }, ip });
      eq(v.statusCode, 200, JSON.stringify(v.body));
      ok(cookieToken(v), "cookie issued via twilio path");
      const checks = calls.filter((c) => c.url === CHECK_URL);
      eq(checks.length, 2);
      eq(checks[1].body, { Code: "123456", VerificationSid: VE_SID }, "check uses VerificationSid + Code (never To=SID)");
      eq((await call(H.me, { token: cookieToken(v) })).statusCode, 200);
      ok(calls.every((c) => !JSON.stringify(c).includes("000000")), "mock code never sent to Twilio");

      // provider start failure -> 500 ACCOUNT_OTP_SEND_FAILED, no challenge row
      startOk = false;
      const before = await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges");
      const lines = await captureConsole(async () => {
        const f = await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone } });
        eq(f.statusCode, 500);
        eq(f.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_SEND_FAILED });
      });
      eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), before, "failed start leaves no challenge");
      ok(lines.some((l) => l.includes("[api/account/login-start] failed")), "failure logged");
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of [
        ["OTP_PROVIDER", saved.provider],
        ["TWILIO_ACCOUNT_SID", saved.sid],
        ["TWILIO_AUTH_TOKEN", saved.auth],
        ["TWILIO_VERIFY_SERVICE_SID", saved.svc],
        ["OTP_CHANNEL", saved.channel],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetOtpProviderCache();
    }
    eq(process.env.OTP_PROVIDER, "mock", "provider restored");
    eq(process.env.TWILIO_AUTH_TOKEN, undefined, "twilio env cleaned up");
    ok(globalThis.fetch === saved.fetch, "fetch restored");
    eq((await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone } })).statusCode, 200, "mock path works again");
  });

  /* 4b ----------------------------------------------------------- */
  await section("4b. login-verify Twilio OtpProviderError: max_attempts 429 / number_rejected 400 (fake fetch)", async () => {
    await setAccounts("1");
    const SERVICE_SID = "VA" + "d".repeat(32);
    const ACCOUNT_SID = "AC" + "e".repeat(32);
    const AUTH_TOKEN = "test-auth-token-batch35";
    const VE_SID = "VE" + "f".repeat(32);
    const START_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/Verifications`;
    const CHECK_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/VerificationCheck`;
    const saved = {
      fetch: globalThis.fetch,
      provider: process.env.OTP_PROVIDER,
      sid: process.env.TWILIO_ACCOUNT_SID,
      auth: process.env.TWILIO_AUTH_TOKEN,
      svc: process.env.TWILIO_VERIFY_SERVICE_SID,
      channel: process.env.OTP_CHANNEL,
    };
    let checkMode = "max";
    try {
      process.env.OTP_PROVIDER = "twilio_verify";
      delete process.env.OTP_CHANNEL;
      process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
      process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
      process.env.TWILIO_VERIFY_SERVICE_SID = SERVICE_SID;
      resetOtpProviderCache();
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === START_URL) {
          return new Response(JSON.stringify({ sid: VE_SID }), { status: 201 });
        }
        if (u === CHECK_URL) {
          if (checkMode === "max") {
            return new Response(JSON.stringify({ code: 60202, message: "max checks" }), { status: 429 });
          }
          return new Response(JSON.stringify({ code: 60200, message: "invalid param" }), { status: 400 });
        }
        throw new Error("unexpected outbound fetch: " + u);
      };

      const pMax = newPerson();
      const ipMax = freshIp();
      const sMax = await call(H.loginStart, { method: "POST", body: { phone: pMax.phoneFormatted }, ip: ipMax });
      eq(sMax.statusCode, 200, JSON.stringify(sMax.body));
      const linesMax = await captureConsole(async () => {
        const r = await call(H.loginVerify, {
          method: "POST",
          body: { challengeId: sMax.body.challengeId, code: "123456" },
          ip: ipMax,
        });
        eq(r.statusCode, 429);
        eq(r.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_MAX_ATTEMPTS });
      });
      ok(
        linesMax.some((l) => l.includes("[otp] login-verify failed") && l.includes("kind=") && l.includes("http=") && l.includes("code=")),
        "max_attempts log has kind/http/code"
      );
      ok(!linesMax.some((l) => l.includes(pMax.phoneFormatted) || l.includes(pMax.phone)), "log never includes phone");

      checkMode = "reject";
      const pRej = newPerson();
      const ipRej = freshIp();
      const sRej = await call(H.loginStart, { method: "POST", body: { phone: pRej.phoneFormatted }, ip: ipRej });
      eq(sRej.statusCode, 200, JSON.stringify(sRej.body));
      const linesRej = await captureConsole(async () => {
        const r = await call(H.loginVerify, {
          method: "POST",
          body: { challengeId: sRej.body.challengeId, code: "123456" },
          ip: ipRej,
        });
        eq(r.statusCode, 400);
        eq(r.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_NUMBER_REJECTED });
      });
      ok(
        linesRej.some((l) => l.includes("[otp] login-verify failed") && l.includes("kind=") && l.includes("http=") && l.includes("code=")),
        "number_rejected log has kind/http/code"
      );
      ok(!linesRej.some((l) => l.includes(pRej.phoneFormatted) || l.includes(pRej.phone)), "reject log never includes phone");
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of [
        ["OTP_PROVIDER", saved.provider],
        ["TWILIO_ACCOUNT_SID", saved.sid],
        ["TWILIO_AUTH_TOKEN", saved.auth],
        ["TWILIO_VERIFY_SERVICE_SID", saved.svc],
        ["OTP_CHANNEL", saved.channel],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetOtpProviderCache();
    }
  });

  /* 5 ------------------------------------------------------------ */
  await section("5. login-verify hardening: wrong code, lockout, reuse, wrong purpose, bad hints, disabled customer", async () => {
    await setAccounts("1");
    const start = async (p) => {
      const ip = freshIp();
      const s = await call(H.loginStart, { method: "POST", body: { phone: p.phone }, ip });
      eq(s.statusCode, 200);
      return { id: s.body.challengeId, ip };
    };
    const verify = (c, body, extra = {}) => call(H.loginVerify, { method: "POST", body: { challengeId: c.id, ...body }, ip: c.ip, ...extra });

    // wrong code x4 -> 400, 5th -> locked (429); correct code afterwards still refused
    const p = newPerson();
    const c = await start(p);
    for (let i = 0; i < 4; i += 1) {
      const r = await verify(c, { code: "111111" }, { keepLimits: i > 0 });
      eq(r.statusCode, 400, `wrong code #${i + 1}`);
      eq(r.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
      ok(!r.headers["set-cookie"]);
    }
    const locked = await verify(c, { code: "111111" }, { keepLimits: true });
    eq(locked.statusCode, 429);
    eq(locked.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_LOCKED });
    const after = await verify(c, { code: "000000" });
    eq(after.statusCode, 429, "correct code refused after lockout");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers WHERE phone_norm = ?", [p.phoneNorm]), 0, "no customer from a failed login");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 0);

    // shape validation
    const c2 = await start(newPerson());
    for (const body of [{}, { code: "000000" }, { challengeId: "x", code: "000000" }]) {
      eq((await call(H.loginVerify, { method: "POST", body, ip: c2.ip })).statusCode, 400, JSON.stringify(body));
    }
    for (const code of ["", "abc", "12", "123456789", 123456, null]) {
      eq((await verify(c2, { code })).statusCode, 400, `code ${JSON.stringify(code)}`);
    }
    eq((await call(H.loginVerify, { method: "POST", body: { challengeId: crypto.randomUUID(), code: "000000" } })).statusCode, 404, "unknown challenge");
    eq((await one(pool, "SELECT attempts, status FROM otp_challenges WHERE id = ?", [c2.id])), { attempts: 0, status: "sent" }, "malformed requests burn nothing");

    // bad optional hints are rejected BEFORE the OTP is spent
    for (const hint of [{ email: "not-an-email" }, { email: 5 }, { name: 7 }, { name: "n".repeat(256) }]) {
      const r = await verify(c2, { code: "000000", ...hint });
      eq(r.statusCode, 400, `hint ${JSON.stringify(hint).slice(0, 30)}`);
    }
    eq((await one(pool, "SELECT status FROM otp_challenges WHERE id = ?", [c2.id])).status, "sent", "challenge not spent by bad hints");

    // valid hints are stored (email normalised separately), then the challenge cannot be reused
    const p2 = newPerson();
    const c3 = await start(p2);
    const good = await verify(c3, { code: "000000", name: "  Ayesha Khan ", email: " Ayesha.K+shop@Gmail.com " });
    eq(good.statusCode, 200, JSON.stringify(good.body));
    const cust = await customerRow(p2.phoneNorm);
    eq(cust.name, "Ayesha Khan");
    eq(cust.email, "Ayesha.K+shop@Gmail.com");
    eq(cust.email_norm, "ayeshak@gmail.com", "gmail dots + tag stripped in email_norm");
    const reuse = await verify(c3, { code: "000000" });
    eq(reuse.statusCode, 409, "verified challenge cannot be reused");
    eq(reuse.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_EXPIRED });
    ok(!reuse.headers["set-cookie"]);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 1, "reuse created no extra session");

    // later login without hints keeps stored name/email (COALESCE)
    const again = await login(p2);
    const cust2 = await customerRow(p2.phoneNorm);
    eq(Number(cust2.id), again.id);
    eq([cust2.name, cust2.email], ["Ayesha Khan", "Ayesha.K+shop@Gmail.com"]);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers WHERE phone_norm = ?", [p2.phoneNorm]), 1, "upsert, not duplicate");

    // wrong-purpose (COD checkout) challenge can never create a session
    const p3 = newPerson();
    const codId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO otp_challenges (id, phone_norm, purpose, provider, provider_ref, status, attempts, expires_at)
       VALUES (?, ?, 'cod_checkout', 'mock', ?, 'sent', 0, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [codId, p3.phoneNorm, `mock:+92${p3.phoneNorm.slice(1)}`]
    );
    const wrong = await call(H.loginVerify, { method: "POST", body: { challengeId: codId, code: "000000" } });
    eq(wrong.statusCode, 400);
    eq(wrong.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
    ok(!wrong.headers["set-cookie"]);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers WHERE phone_norm = ?", [p3.phoneNorm]), 0);
    eq((await one(pool, "SELECT status FROM otp_challenges WHERE id = ?", [codId])).status, "sent", "wrong-purpose verification rolled back");

    // expired challenge
    const c4 = await start(newPerson());
    await pool.query("UPDATE otp_challenges SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?", [c4.id]);
    const exp = await verify(c4, { code: "000000" });
    eq(exp.statusCode, 409);
    eq(exp.body, { error: CUSTOMER_TEXTS.ACCOUNT_OTP_EXPIRED });

    // disabled customer: refused, no session, challenge not consumed
    const p5 = newPerson();
    await pool.query("INSERT INTO customers (phone_norm, status) VALUES (?, 'disabled')", [p5.phoneNorm]);
    const c5 = await start(p5);
    const dis = await verify(c5, { code: "000000" });
    eq(dis.statusCode, 403);
    ok(!dis.headers["set-cookie"]);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [(await customerRow(p5.phoneNorm)).id]), 0);
    eq((await one(pool, "SELECT status FROM otp_challenges WHERE id = ?", [c5.id])).status, "sent", "disabled login rolled back");
  });

  /* 6 ------------------------------------------------------------ */
  await section("6. session rotation on re-login; revoke on logout", async () => {
    await setAccounts("1");
    const a = newPerson();
    const b = newPerson();
    const first = await login(a);
    const other = await login(b);
    eq((await call(H.me, { token: first.token })).statusCode, 200);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [first.id]), 1);

    const second = await login(a);
    eq(second.id, first.id, "same customer");
    ok(second.token !== first.token, "new token");
    eq((await call(H.me, { token: first.token })).statusCode, 401, "prior session deleted by rotation");
    eq((await call(H.me, { token: second.token })).statusCode, 200, "new session live");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [first.id]), 1, "exactly one session per customer");
    eq((await call(H.me, { token: other.token })).statusCode, 200, "other customer's session untouched by rotation");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions"), 2);

    // logout revokes only the caller's session
    const lo = await call(H.logout, { method: "POST", token: second.token });
    eq(lo.statusCode, 200);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [first.id]), 0, "row revoked");
    eq((await call(H.me, { token: second.token })).statusCode, 401);
    eq((await call(H.me, { token: other.token })).statusCode, 200, "other still logged in");
    // logout is idempotent and works with no cookie
    eq((await call(H.logout, { method: "POST", token: second.token })).statusCode, 200);
    eq((await call(H.logout, { method: "POST" })).statusCode, 200);
    // cross-origin logout is refused and revokes nothing
    eq((await call(H.logout, { method: "POST", token: other.token, headers: { origin: "http://evil.test" } })).statusCode, 403);
    eq((await call(H.me, { token: other.token })).statusCode, 200, "cross-origin logout did not revoke");

    // an expired session is rejected by every protected route
    await pool.query("UPDATE customer_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE customer_id = ?", [other.id]);
    for (const [h, m] of [[H.me, "GET"], [H.orders, "GET"], [H.addresses, "GET"], [H.wishlist, "GET"]]) {
      eq((await call(h, { method: m, token: other.token })).statusCode, 401, "expired session");
    }
  });

  /* 7 ------------------------------------------------------------ */
  await section("7. orders ownership: A cannot see B; phone_norm match lists unlinked guest orders for the same phone", async () => {
    await setAccounts("1");
    const a = newPerson();
    const b = newPerson();
    const other = newPerson();
    const A = await login(a);
    const B = await login(b);

    const oA = await insertOrder({ phoneNorm: a.phoneNorm, customerId: A.id, items: 2 });
    const oB = await insertOrder({ phoneNorm: b.phoneNorm, customerId: B.id });
    const gA = await insertOrder({ phoneNorm: a.phoneNorm }); // unlinked guest order, A's verified phone
    const gB = await insertOrder({ phoneNorm: b.phoneNorm });
    const gOther = await insertOrder({ phoneNorm: other.phoneNorm });
    const gNoNorm = await insertOrder({ phoneNorm: null }); // phone_norm NULL: never matched
    const stolen = await insertOrder({ phoneNorm: a.phoneNorm, customerId: B.id }); // linked to B although phone is A's

    const listA = await call(H.orders, { token: A.token });
    eq(listA.statusCode, 200, JSON.stringify(listA.body));
    eq(listA.body.orders.map((o) => o.order_id).sort(), [oA, gA].sort(), "A sees own + same-phone unlinked guest order only");
    const rowA = listA.body.orders.find((o) => o.order_id === oA);
    eq(Object.keys(rowA).sort(), ["created_at", "item_count", "order_id", "payment_method", "status", "total"]);
    eq(rowA.item_count, 2);

    const listB = await call(H.orders, { token: B.token });
    eq(listB.body.orders.map((o) => o.order_id).sort(), [oB, gB, stolen].sort(), "B sees own + linked + same-phone guest");
    for (const o of [oB, gB, gOther, gNoNorm]) ok(!listA.body.orders.some((x) => x.order_id === o), `A must not see ${o}`);
    ok(!listB.body.orders.some((x) => x.order_id === oA || x.order_id === gA), "B must not see A's orders");

    const detail = (id, token) => call(H.orderDetail, { token, query: { orderId: id } });
    eq((await detail(oA, A.token)).statusCode, 200);
    const dA = await detail(gA, A.token);
    eq(dA.statusCode, 200, "unlinked same-phone guest order viewable");
    eq(dA.body.order.order_id, gA);
    eq(dA.body.order.items.length, 1);
    eq(dA.body.order.items[0], { product_id: P1, product_name: "Acct Active", price: "1000.00", quantity: 1 });
    for (const id of [oB, gB, gOther, gNoNorm, stolen, "ORD-DOES-NOT-EXIST", "x".repeat(60)]) {
      const r = await detail(id, A.token);
      eq(r.statusCode, 404, `A must not read ${id.slice(0, 12)}`);
      eq(r.body, NOT_FOUND, "same body as a non-existent order (no existence oracle)");
    }
    eq((await detail(oA, B.token)).statusCode, 404, "B cannot read A's order");
    eq((await detail(gA, B.token)).statusCode, 404);
    eq((await detail(stolen, A.token)).statusCode, 404, "an order linked to B is never visible to A, even with A's phone");
    eq((await detail(stolen, B.token)).statusCode, 200);
    eq((await call(H.orderDetail, { query: { orderId: oA } })).statusCode, 401, "no session");
    eq((await call(H.orders, {})).statusCode, 401);
    eq((await call(H.orders, { method: "POST", token: A.token })).statusCode, 405);
    eq((await call(H.orderDetail, { method: "POST", token: A.token, query: { orderId: oA } })).statusCode, 405);
    eq((await call(H.orderDetail, { token: A.token, query: { orderId: ["a", "b"] } })).statusCode, 404, "array orderId");
  });

  /* 8 ------------------------------------------------------------ */
  await section("8. claim past orders by phone only", async () => {
    await setAccounts("1");
    const a = newPerson();
    const b = newPerson();
    const A = await login(a, { email: "claim.a@example.test" });
    const B = await login(b);

    const g1 = await insertOrder({ phoneNorm: a.phoneNorm });
    const g2 = await insertOrder({ phoneNorm: a.phoneNorm });
    const sameEmail = await insertOrder({ phoneNorm: newPerson().phoneNorm, email: "claim.a@example.test" }); // email match only
    const noNorm = await insertOrder({ phoneNorm: null, email: "claim.a@example.test" });
    const gB = await insertOrder({ phoneNorm: b.phoneNorm });
    const linkedElsewhere = await insertOrder({ phoneNorm: a.phoneNorm, customerId: B.id });

    eq((await call(H.claim, { method: "POST" })).statusCode, 401, "claim needs a session");
    eq((await call(H.claim, { method: "GET", token: A.token })).statusCode, 405);
    eq((await call(H.claim, { method: "POST", token: A.token, headers: { origin: "http://evil.test" } })).statusCode, 403);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE customer_id = ?", [A.id]), 0, "nothing claimed yet");

    const r = await call(H.claim, { method: "POST", token: A.token });
    eq(r.statusCode, 200, JSON.stringify(r.body));
    eq(r.body, { linked: 2 });
    for (const id of [g1, g2]) eq(Number((await orderRow(id)).customer_id), A.id, "claimed by phone");
    eq((await orderRow(sameEmail)).customer_id, null, "email-only match is not claimed");
    eq((await orderRow(noNorm)).customer_id, null, "NULL phone_norm is not claimed");
    eq((await orderRow(gB)).customer_id, null, "other phone untouched");
    eq(Number((await orderRow(linkedElsewhere)).customer_id), B.id, "already-linked order is never stolen");

    eq((await call(H.claim, { method: "POST", token: A.token })).body, { linked: 0 }, "idempotent");
    const rb = await call(H.claim, { method: "POST", token: B.token });
    eq(rb.body, { linked: 1 }, "B claims only B's phone");
    eq(Number((await orderRow(gB)).customer_id), B.id);
    eq(Number((await orderRow(g1)).customer_id), A.id, "A's claimed orders stay A's");

    // after claiming, the list is by customer_id and still scoped
    const listA = await call(H.orders, { token: A.token });
    eq(listA.body.orders.map((o) => o.order_id).sort(), [g1, g2].sort());
  });

  /* 9 ------------------------------------------------------------ */
  await section("9. order stamp: logged-in checkout sets customer_id; guest / dead session / flag-off do not", async () => {
    await setAccounts("1");
    const a = newPerson();
    const A = await login(a);

    const placed = await place(a, { token: A.token });
    eq(placed.statusCode, 200, JSON.stringify(placed.body));
    eq(Number((await orderRow(placed.body.order_id)).customer_id), A.id, "stamped with the signed-in customer");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?", [placed.body.order_id]), 1, "items written");

    // a signed-in customer may order for someone else's details: still stamped to the account holder
    const gift = await place(newPerson(), { token: A.token });
    eq(gift.statusCode, 200);
    eq(Number((await orderRow(gift.body.order_id)).customer_id), A.id);

    const guest = await place(newPerson());
    eq(guest.statusCode, 200);
    eq((await orderRow(guest.body.order_id)).customer_id, null, "guest not stamped");

    const bogus = await place(newPerson(), { token: "e".repeat(64) });
    eq(bogus.statusCode, 200, "unknown cookie does not break checkout");
    eq((await orderRow(bogus.body.order_id)).customer_id, null);

    await pool.query("UPDATE customer_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE customer_id = ?", [A.id]);
    const expired = await place(a, { token: A.token });
    eq(expired.statusCode, 200);
    eq((await orderRow(expired.body.order_id)).customer_id, null, "expired session -> guest checkout");

    // stamped orders show up in the account list (customer_id match; phone_norm may be NULL when protection is off)
    const B = await login(newPerson());
    const bOrder = await place(newPerson(), { token: B.token });
    const listB = await call(H.orders, { token: B.token });
    eq(listB.body.orders.map((o) => o.order_id), [bOrder.body.order_id]);
    const det = await call(H.orderDetail, { token: B.token, query: { orderId: bOrder.body.order_id } });
    eq(det.statusCode, 200);
    eq(det.body.order.items.length, 1);

    // stamping is transactional with a refused order: an invalid cart creates nothing
    const before = await count(pool, "SELECT COUNT(*) AS c FROM orders");
    const bad = await place(a, { token: B.token, items: [{ id: PX, qty: 1 }] });
    eq(bad.statusCode, 400, "inactive product refused");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders"), before, "no order row");

    // with COD protection on (phone_norm recorded), a guest order is still linkable by phone afterwards
    await setProtection({ cod_protection_enabled: 1 });
    const c = newPerson();
    const C = await login(c);
    const gOrder = await place(c);
    eq(gOrder.statusCode, 200, JSON.stringify(gOrder.body));
    const row = await orderRow(gOrder.body.order_id);
    eq(row.customer_id, null);
    eq(row.customer_phone_norm, c.phoneNorm);
    const listC = await call(H.orders, { token: C.token });
    eq(listC.body.orders.map((o) => o.order_id), [gOrder.body.order_id], "guest order for the same verified phone is visible");
    eq((await call(H.claim, { method: "POST", token: C.token })).body, { linked: 1 });
    eq(Number((await orderRow(gOrder.body.order_id)).customer_id), C.id);
  });

  /* 10 ------------------------------------------------------------ */
  await section("10. addresses CRUD + exactly one default", async () => {
    await setAccounts("1");
    const A = await login(newPerson());
    const B = await login(newPerson());

    eq((await call(H.addresses, {})).statusCode, 401);
    eq((await call(H.addresses, { method: "POST", body: addr(), headers: { origin: "http://evil.test" }, token: A.token })).statusCode, 403, "cross-origin write");
    eq((await call(H.addresses, { method: "PUT", token: A.token })).statusCode, 405);

    // first address is always the default
    const c1 = await call(H.addresses, { method: "POST", token: A.token, body: addr({ label: "Home" }) });
    eq(c1.statusCode, 201, JSON.stringify(c1.body));
    eq(c1.body.ok, true);
    const id1 = c1.body.id;
    eq(defaults(await addrRows(A.id)), 1);
    eq(Number((await addrRows(A.id))[0].is_default), 1, "first address is default");

    // second without flag -> not default; third with is_default -> takes over
    const id2 = (await call(H.addresses, { method: "POST", token: A.token, body: addr({ label: "Work", line1: "Office 2" }) })).body.id;
    let rows = await addrRows(A.id);
    eq(rows.map((r) => [r.id, Number(r.is_default)]), [[id1, 1], [id2, 0]]);
    const id3 = (await call(H.addresses, { method: "POST", token: A.token, body: addr({ label: "Gift", is_default: true }) })).body.id;
    rows = await addrRows(A.id);
    eq(rows.map((r) => [r.id, Number(r.is_default)]), [[id1, 0], [id2, 0], [id3, 1]]);
    eq(defaults(rows), 1);

    // GET: default first, then newest; only my rows; trimmed + nullables
    const list = await call(H.addresses, { token: A.token });
    eq(list.statusCode, 200);
    eq(list.body.addresses.map((r) => r.id), [id3, id2, id1]);
    eq(list.body.addresses[0].label, "Gift");
    eq((await call(H.addresses, { token: B.token })).body, { addresses: [] }, "B sees none of A's");

    // optional fields normalise to NULL; required fields enforced; wrong types/lengths rejected
    const minimal = await call(H.addresses, { method: "POST", token: B.token, body: { full_name: "  Zed ", phone: "0300", line1: " L1 ", city: " Karachi ", label: "", line2: "  ", is_default: "0" } });
    eq(minimal.statusCode, 201, JSON.stringify(minimal.body));
    const mrow = (await addrRows(B.id))[0];
    eq([mrow.full_name, mrow.line1, mrow.city, mrow.label, mrow.line2, mrow.province, mrow.postcode], ["Zed", "L1", "Karachi", null, null, null, null]);
    const before = (await addrRows(A.id)).length;
    for (const bad of [
      addr({ city: "" }),
      addr({ full_name: undefined }),
      addr({ phone: "   " }),
      addr({ line1: undefined }),
      addr({ line1: "x".repeat(501) }),
      addr({ label: "x".repeat(61) }),
      addr({ city: 5 }),
      addr({ is_default: "maybe" }),
      addr({ is_default: 2 }),
    ]) {
      const r = await call(H.addresses, { method: "POST", token: A.token, body: bad });
      eq(r.statusCode, 400, JSON.stringify(bad).slice(0, 60));
    }
    eq((await addrRows(A.id)).length, before, "invalid addresses stored nothing");

    // PATCH: partial update, default handling
    const up = await call(H.addresses, { method: "PATCH", token: A.token, body: { id: id2, city: "Islamabad", label: "Office" } });
    eq(up.statusCode, 200, JSON.stringify(up.body));
    let r2 = (await addrRows(A.id)).find((r) => r.id === id2);
    eq([r2.city, r2.label, r2.line1, Number(r2.is_default)], ["Islamabad", "Office", "Office 2", 0], "other fields preserved");
    const mv = await call(H.addresses, { method: "PATCH", token: A.token, body: { id: id2, is_default: 1 } });
    eq(mv.statusCode, 200);
    rows = await addrRows(A.id);
    eq(rows.map((r) => [r.id, Number(r.is_default)]), [[id1, 0], [id2, 1], [id3, 0]], "default moved");
    // un-defaulting the only default is a no-op (never zero defaults)
    await call(H.addresses, { method: "PATCH", token: A.token, body: { id: id2, is_default: 0 } });
    eq(defaults(await addrRows(A.id)), 1, "cannot leave zero defaults");
    // id via query string works too
    eq((await call(H.addresses, { method: "PATCH", token: A.token, query: { id: String(id1) }, body: { label: "Home2" } })).statusCode, 200);
    eq((await addrRows(A.id)).find((r) => r.id === id1).label, "Home2");
    // validation on PATCH
    eq((await call(H.addresses, { method: "PATCH", token: A.token, body: { id: id1, city: "" } })).statusCode, 400, "cannot blank a required field");
    eq((await call(H.addresses, { method: "PATCH", token: A.token, body: { city: "X" } })).statusCode, 400, "missing id");
    eq((await call(H.addresses, { method: "PATCH", token: A.token, body: { id: "abc", city: "X" } })).statusCode, 400);
    eq((await call(H.addresses, { method: "PATCH", token: A.token, body: { id: 999999, city: "X" } })).statusCode, 404);

    // ownership: B cannot touch A's rows
    const snapshot = JSON.stringify(await addrRows(A.id));
    eq((await call(H.addresses, { method: "PATCH", token: B.token, body: { id: id1, city: "Hacked" } })).statusCode, 404);
    eq((await call(H.addresses, { method: "PATCH", token: B.token, body: { id: id1, is_default: 1 } })).statusCode, 404);
    eq((await call(H.addresses, { method: "DELETE", token: B.token, body: { id: id1 } })).statusCode, 404);
    eq(JSON.stringify(await addrRows(A.id)), snapshot, "A's addresses untouched by B");

    // DELETE: removing the default promotes the newest remaining; non-default delete leaves default alone
    eq((await call(H.addresses, { method: "DELETE", token: A.token, body: { id: id2 } })).statusCode, 200);
    rows = await addrRows(A.id);
    eq(rows.map((r) => [r.id, Number(r.is_default)]), [[id1, 0], [id3, 1]], "newest promoted to default");
    eq((await call(H.addresses, { method: "DELETE", token: A.token, query: { id: String(id1) } })).statusCode, 200, "delete via query id");
    rows = await addrRows(A.id);
    eq(rows.map((r) => [r.id, Number(r.is_default)]), [[id3, 1]], "default untouched when a non-default is removed");
    eq((await call(H.addresses, { method: "DELETE", token: A.token, body: { id: id1 } })).statusCode, 404, "already gone");
    eq((await call(H.addresses, { method: "DELETE", token: A.token, body: {} })).statusCode, 400);
    eq((await call(H.addresses, { method: "DELETE", token: A.token, body: { id: id3 } })).statusCode, 200);
    eq((await addrRows(A.id)).length, 0, "last address removable");

    // cap of 20, still exactly one default
    for (let i = 0; i < 20; i += 1) {
      const r = await call(H.addresses, { method: "POST", token: A.token, body: addr({ label: `L${i}`, is_default: i % 7 === 0 }) });
      eq(r.statusCode, 201, `address #${i + 1}`);
    }
    eq(defaults(await addrRows(A.id)), 1, "one default among 20");
    eq((await call(H.addresses, { method: "POST", token: A.token, body: addr() })).statusCode, 400, "21st address refused");
    eq((await addrRows(A.id)).length, 20);

    // concurrent default-setting keeps the invariant
    const ids = (await addrRows(A.id)).map((r) => r.id);
    await Promise.all(ids.slice(0, 6).map((id) => call(H.addresses, { method: "PATCH", token: A.token, body: { id, is_default: 1 }, keepLimits: true })));
    eq(defaults(await addrRows(A.id)), 1, "exactly one default after concurrent PATCHes");
  });

  /* 11 ------------------------------------------------------------ */
  await section("11. wishlist uniqueness + active product rule (inactive / unknown rejected)", async () => {
    await setAccounts("1");
    const A = await login(newPerson());
    const B = await login(newPerson());
    const wl = (customerId) => count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist WHERE customer_id = ?", [customerId]);

    eq((await call(H.wishlist, {})).statusCode, 401);
    eq((await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P1 }, headers: { origin: "http://evil.test" } })).statusCode, 403);
    eq((await call(H.wishlist, { method: "PUT", token: A.token })).statusCode, 405);
    eq((await call(H.wishlist, { token: A.token })).body, { items: [] });

    const add = await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P1 } });
    eq(add.statusCode, 201, JSON.stringify(add.body));
    eq(add.body, { ok: true });
    const dup = await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P1 } });
    eq(dup.statusCode, 200, "duplicate add is idempotent");
    eq(dup.body, { ok: true });
    eq(await wl(A.id), 1, "unique (customer, product)");
    eq((await call(H.wishlist, { method: "POST", token: A.token, body: { productId: String(P1) } })).statusCode, 200, "string id is the same product");
    eq(await wl(A.id), 1);
    eq((await call(H.wishlist, { method: "POST", token: B.token, body: { productId: P1 } })).statusCode, 201, "another customer may wishlist the same product");

    // the DB constraint itself
    await assert.rejects(
      () => pool.query("INSERT INTO customer_wishlist (customer_id, product_id) VALUES (?, ?)", [A.id, P1]),
      (e) => e.code === "ER_DUP_ENTRY"
    );
    eq(await wl(A.id), 1);

    // inactive / unknown / malformed product ids
    const rej = await call(H.wishlist, { method: "POST", token: A.token, body: { productId: PX } });
    eq(rej.statusCode, 404, "inactive product rejected");
    eq(rej.body, NOT_FOUND);
    eq((await call(H.wishlist, { method: "POST", token: A.token, body: { productId: 987654 } })).statusCode, 404, "unknown product rejected");
    for (const bad of [undefined, null, "abc", -1, 0, 1.5, "1e3", [], {}, "1; DROP TABLE x"]) {
      eq((await call(H.wishlist, { method: "POST", token: A.token, body: { productId: bad } })).statusCode, 400, `productId ${JSON.stringify(bad)}`);
    }
    eq(await wl(A.id), 1, "rejected adds stored nothing");

    // GET lists active products only; a product that later becomes inactive disappears from the list
    await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P2 } });
    let list = await call(H.wishlist, { token: A.token });
    eq(list.statusCode, 200);
    eq(list.body.items.map((i) => i.product_id), [P2, P1], "newest first");
    eq(list.body.items[1].name, "Acct Active");
    eq(Number(list.body.items[1].price), 1000);
    eq(list.body.items[1].slug, "acct-active");
    await pool.query("UPDATE products SET active = 0 WHERE id = ?", [P2]);
    list = await call(H.wishlist, { token: A.token });
    eq(list.body.items.map((i) => i.product_id), [P1], "deactivated product hidden");
    eq(await wl(A.id), 2, "row retained (re-appears if the product is reactivated)");
    await pool.query("UPDATE products SET active = 1 WHERE id = ?", [P2]);
    eq((await call(H.wishlist, { token: A.token })).body.items.length, 2);
    // a deleted product also vanishes (inner join)
    await pool.query("INSERT INTO customer_wishlist (customer_id, product_id) VALUES (?, 424242)", [A.id]);
    eq((await call(H.wishlist, { token: A.token })).body.items.length, 2, "orphan wishlist row not listed");

    // B's list is independent; DELETE is scoped and idempotent
    eq((await call(H.wishlist, { token: B.token })).body.items.map((i) => i.product_id), [P1]);
    eq((await call(H.wishlist, { method: "DELETE", token: B.token, body: { productId: P2 } })).statusCode, 200, "removing a non-member is fine");
    eq(await wl(A.id), 3, "B's delete did not touch A");
    eq((await call(H.wishlist, { method: "DELETE", token: A.token, body: { productId: P1 } })).statusCode, 200);
    eq((await call(H.wishlist, { method: "DELETE", token: A.token, query: { productId: String(P2) } })).statusCode, 200, "delete via query");
    eq((await call(H.wishlist, { token: A.token })).body.items, []);
    eq((await call(H.wishlist, { method: "DELETE", token: A.token, body: {} })).statusCode, 400);
    eq((await call(H.wishlist, { token: B.token })).body.items.length, 1, "B still has P1");

    // cap of 200
    await pool.query("DELETE FROM customer_wishlist WHERE customer_id = ?", [A.id]);
    const values = Array.from({ length: 200 }, (_, i) => `(${A.id}, ${100000 + i})`).join(",");
    await pool.query(`INSERT INTO customer_wishlist (customer_id, product_id) VALUES ${values}`);
    eq((await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P1 } })).statusCode, 400, "201st item refused");
  });

  /* 12 ------------------------------------------------------------ */
  await section("12. profile update (name / email), validation, auth", async () => {
    await setAccounts("1");
    const p = newPerson();
    const A = await login(p);

    eq((await call(H.profile, { method: "PATCH", body: { name: "X" } })).statusCode, 401);
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { name: "X" }, headers: { origin: "http://evil.test" } })).statusCode, 403);
    eq((await call(H.profile, { method: "GET", token: A.token })).statusCode, 405);
    eq((await call(H.profile, { method: "POST", token: A.token, body: { name: "X" } })).statusCode, 405);
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: {} })).statusCode, 400, "nothing to update");
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: [] })).statusCode, 400);

    const r = await call(H.profile, { method: "PATCH", token: A.token, body: { name: "  Sara Ali  ", email: " Sara.Ali@Example.test " } });
    eq(r.statusCode, 200, JSON.stringify(r.body));
    eq(r.body, { ok: true, customer: { id: A.id, phone_norm: p.phoneNorm, name: "Sara Ali", email: "Sara.Ali@Example.test" } });
    const row = await customerRow(p.phoneNorm);
    eq([row.name, row.email, row.email_norm], ["Sara Ali", "Sara.Ali@Example.test", "sara.ali@example.test"]);
    eq((await call(H.me, { token: A.token })).body.customer, { id: A.id, phone_norm: p.phoneNorm, name: "Sara Ali", email: "Sara.Ali@Example.test" });
    eq(row.phone_norm, p.phoneNorm, "phone is never editable");

    // name only leaves the email alone; name null / empty clears; email "" / null clears + norm
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { name: "Sara A." } })).statusCode, 200);
    eq((await customerRow(p.phoneNorm)).email, "Sara.Ali@Example.test", "email untouched by a name-only update");
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { name: null } })).statusCode, 200);
    eq((await customerRow(p.phoneNorm)).name, null);
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { name: "   " } })).statusCode, 200);
    eq((await customerRow(p.phoneNorm)).name, null, "blank name -> NULL");
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { email: "" } })).statusCode, 200);
    const cleared = await customerRow(p.phoneNorm);
    eq([cleared.email, cleared.email_norm], [null, null], "email cleared with its norm");
    eq((await call(H.profile, { method: "PATCH", token: A.token, body: { email: "x.y+tag@gmail.com" } })).statusCode, 200);
    eq((await customerRow(p.phoneNorm)).email_norm, "xy@gmail.com");

    // invalid input never writes
    const snap = JSON.stringify(await customerRow(p.phoneNorm));
    for (const bad of [{ email: "nope" }, { email: 5 }, { email: "a@" }, { name: 5 }, { name: "n".repeat(256) }, { name: {} }]) {
      eq((await call(H.profile, { method: "PATCH", token: A.token, body: bad })).statusCode, 400, JSON.stringify(bad).slice(0, 40));
    }
    eq(JSON.stringify(await customerRow(p.phoneNorm)), snap, "invalid updates changed nothing");
    // unknown fields (phone, status) are ignored, not applied
    const sneaky = await call(H.profile, { method: "PATCH", token: A.token, body: { name: "Still Sara", phone_norm: "03000000000", status: "disabled", id: 1 } });
    eq(sneaky.statusCode, 200);
    const after = await customerRow(p.phoneNorm);
    eq([after.name, after.status, Number(after.id)], ["Still Sara", "active", A.id]);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customers WHERE phone_norm = '03000000000'"), 0);
  });

  /* 13 ------------------------------------------------------------ */
  await section("13. delete account: sessions/addresses/wishlist gone; orders kept (customer_id NULL); blacklist row KEPT", async () => {
    await setAccounts("1");
    const a = newPerson();
    const b = newPerson();
    const A = await login(a, { name: "Doomed", email: "doomed@example.test" });
    const B = await login(b);

    await call(H.addresses, { method: "POST", token: A.token, body: addr() });
    await call(H.addresses, { method: "POST", token: A.token, body: addr({ label: "2" }) });
    await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P1 } });
    await call(H.wishlist, { method: "POST", token: A.token, body: { productId: P2 } });
    await call(H.addresses, { method: "POST", token: B.token, body: addr() });
    await call(H.wishlist, { method: "POST", token: B.token, body: { productId: P1 } });
    const placed = await place(a, { token: A.token });
    eq(placed.statusCode, 200, JSON.stringify(placed.body));
    const oStamped = placed.body.order_id;
    const oLinked = await insertOrder({ phoneNorm: a.phoneNorm, customerId: A.id });
    const oB = await insertOrder({ phoneNorm: b.phoneNorm, customerId: B.id });
    await pool.query("INSERT INTO customer_blacklist (phone_norm, email_norm, reason, created_by) VALUES (?, ?, 'fraud', 'test')", [a.phoneNorm, "doomed@example.test"]);
    const bl = await one(pool, "SELECT * FROM customer_blacklist WHERE phone_norm = ?", [a.phoneNorm]);
    const blCount = await count(pool, "SELECT COUNT(*) AS c FROM customer_blacklist");

    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses WHERE customer_id = ?", [A.id]), 2);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist WHERE customer_id = ?", [A.id]), 2);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE customer_id = ?", [A.id]), 2);

    // guards: auth, origin, method, explicit confirmation
    eq((await call(H.del, { method: "POST", body: { confirm: "DELETE" } })).statusCode, 401);
    eq((await call(H.del, { method: "POST", token: A.token, body: { confirm: "DELETE" }, headers: { origin: "http://evil.test" } })).statusCode, 403);
    eq((await call(H.del, { method: "GET", token: A.token })).statusCode, 405);
    for (const body of [{}, { confirm: "delete" }, { confirm: true }, { confirm: "DELETE " }, undefined]) {
      eq((await call(H.del, { method: "POST", token: A.token, body })).statusCode, 400, `confirm ${JSON.stringify(body)}`);
    }
    ok(await customerRow(a.phoneNorm), "nothing deleted by refused requests");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses WHERE customer_id = ?", [A.id]), 2);

    const del = await call(H.del, { method: "POST", token: A.token, body: { confirm: "DELETE" } });
    eq(del.statusCode, 200, JSON.stringify(del.body));
    eq(del.body, { ok: true });
    ok(String(del.headers["set-cookie"]).includes("Max-Age=0"), "cookie cleared");

    eq(await customerRow(a.phoneNorm), undefined, "customer row removed");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [A.id]), 0, "sessions gone");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses WHERE customer_id = ?", [A.id]), 0, "addresses gone");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist WHERE customer_id = ?", [A.id]), 0, "wishlist gone");
    for (const id of [oStamped, oLinked]) {
      const o = await orderRow(id);
      ok(o, `order ${id} kept`);
      eq(o.customer_id, null, "customer_id cleared");
      eq(o.customer_phone_norm === null || o.customer_phone_norm === a.phoneNorm, true);
      eq(await count(pool, "SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?", [id]), 1, "order items kept");
    }
    eq(await one(pool, "SELECT * FROM customer_blacklist WHERE id = ?", [bl.id]), bl, "blacklist row byte-for-byte unchanged");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_blacklist"), blCount);
    eq(Number(bl.active), 1);

    // the old cookie is dead; B untouched
    eq((await call(H.me, { token: A.token })).statusCode, 401);
    eq((await call(H.me, { token: B.token })).statusCode, 200);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_addresses WHERE customer_id = ?", [B.id]), 1);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_wishlist WHERE customer_id = ?", [B.id]), 1);
    eq(Number((await orderRow(oB)).customer_id), B.id, "B's order link untouched");
    eq((await call(H.del, { method: "POST", token: A.token, body: { confirm: "DELETE" } })).statusCode, 401, "second delete with the dead cookie");

    // signing in again with the same phone creates a brand-new, empty account
    const again = await login(a);
    ok(again.id !== A.id, "fresh customer id");
    eq((await call(H.addresses, { token: again.token })).body, { addresses: [] });
    eq((await call(H.wishlist, { token: again.token })).body, { items: [] });
    eq((await call(H.me, { token: again.token })).body.customer.name, null);
    // the orders kept by the delete are still claimable by phone only when phone_norm was recorded
    const claim = await call(H.claim, { method: "POST", token: again.token });
    eq(claim.statusCode, 200);
    eq(claim.body.linked >= 1, true, "kept order with a recorded phone_norm is claimable by the re-registered phone");
  });

  /* 14 ------------------------------------------------------------ */
  await section("14. rate limits smoke: login-start per phone / per IP, login-verify per IP / challenge", async () => {
    await setAccounts("1");
    const tooMany = { error: CUSTOMER_TEXTS.ACCOUNT_OTP_RATE_LIMIT };

    // per phone: 3 per 15 min (use a different IP each time so only the phone bucket can trip)
    const p = newPerson();
    clear();
    for (let i = 0; i < 3; i += 1) {
      const r = await call(H.loginStart, { method: "POST", body: { phone: p.phone }, keepLimits: true });
      eq(r.statusCode, 200, `start #${i + 1}`);
    }
    const fourth = await call(H.loginStart, { method: "POST", body: { phone: p.phoneFormatted }, keepLimits: true });
    eq(fourth.statusCode, 429, "4th request for one phone (any spelling)");
    eq(fourth.body, tooMany);
    const challengesBefore = await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges");
    await call(H.loginStart, { method: "POST", body: { phone: p.phone }, keepLimits: true });
    eq(await count(pool, "SELECT COUNT(*) AS c FROM otp_challenges"), challengesBefore, "429 sends no OTP");
    eq((await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone }, keepLimits: true })).statusCode, 200, "another phone unaffected");

    // per IP: 10 per 15 min across different phones
    clear();
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i += 1) {
      const r = await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone }, ip, keepLimits: true });
      eq(r.statusCode, 200, `ip start #${i + 1}`);
    }
    const eleventh = await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone }, ip, keepLimits: true });
    eq(eleventh.statusCode, 429);
    eq(eleventh.body, tooMany);
    eq((await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone }, ip: "203.0.113.78", keepLimits: true })).statusCode, 200, "other IP unaffected");

    // login-verify per IP: 10 per 15 min (the 11th is throttled even with a valid code)
    clear();
    const vip = "203.0.113.90";
    for (let i = 0; i < 10; i += 1) {
      const r = await call(H.loginVerify, { method: "POST", body: { challengeId: crypto.randomUUID(), code: "000000" }, ip: vip, keepLimits: true });
      eq(r.statusCode, 404, `verify #${i + 1} unknown challenge`);
    }
    const v11 = await call(H.loginVerify, { method: "POST", body: { challengeId: crypto.randomUUID(), code: "000000" }, ip: vip, keepLimits: true });
    eq(v11.statusCode, 429);
    eq(v11.body, tooMany);

    // limits do not apply to a flag-off 404 and a throttled request never sets a cookie
    ok(!v11.headers["set-cookie"]);
    clear();
  });

  /* 15 ------------------------------------------------------------ */
  await section("15. logs: account success / failure paths never print raw phone, email, OTP code or session token", async () => {
    await setAccounts("1");
    const c = { phone: "03339876543", phoneFormatted: "+92 333 9876543", phoneNorm: "03339876543", email: "log.leak.check@example.test" };
    const tokens = [];
    const hidden = [];
    const rename = async (from, to) => {
      await pool.query(`RENAME TABLE ${from} TO ${to}`);
      hidden.push([from, to]);
    };
    const restore = async () => {
      while (hidden.length) {
        const [from, to] = hidden.pop();
        await pool.query(`RENAME TABLE ${to} TO ${from}`);
      }
    };

    const lines = await captureConsole(async () => {
      // happy path with hints, profile, address, wishlist, orders, claim, logout
      const L = await login(c, { name: "Leak Check", email: c.email });
      tokens.push(L.token);
      await call(H.profile, { method: "PATCH", token: L.token, body: { email: c.email } });
      await call(H.addresses, { method: "POST", token: L.token, body: addr({ phone: c.phone }) });
      await call(H.wishlist, { method: "POST", token: L.token, body: { productId: P1 } });
      await call(H.orders, { token: L.token });
      await call(H.claim, { method: "POST", token: L.token });
      await call(H.me, { token: L.token });
      await call(H.logout, { method: "POST", token: L.token });

      // wrong codes / lockout / unknown challenge
      const s = await call(H.loginStart, { method: "POST", body: { phone: c.phoneFormatted }, ip: "198.51.100.200" });
      for (let i = 0; i < 5; i += 1) await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "111111" }, ip: "198.51.100.200", keepLimits: i > 0 });
      await call(H.loginVerify, { method: "POST", body: { challengeId: crypto.randomUUID(), code: "111111" } });
      await call(H.loginVerify, { method: "POST", body: { challengeId: s.body.challengeId, code: "000000", email: c.email.replace("@", "") } });

      // infrastructure failures: handlers log, must not echo identifiers (rename the tables away)
      const L2 = await login(c);
      tokens.push(L2.token);
      try {
        await rename("customer_addresses", "customer_addresses_hidden");
        await rename("customer_wishlist", "customer_wishlist_hidden");
        await call(H.addresses, { token: L2.token });
        await call(H.addresses, { method: "POST", token: L2.token, body: addr({ phone: c.phone }) });
        await call(H.wishlist, { token: L2.token });
        await call(H.wishlist, { method: "POST", token: L2.token, body: { productId: P1 } });
        await call(H.del, { method: "POST", token: L2.token, body: { confirm: "DELETE" } });
        await restore();
        const oid = await insertOrder({ phoneNorm: c.phoneNorm });
        await rename("order_items", "order_items_hidden");
        await call(H.orderDetail, { token: L2.token, query: { orderId: oid } });
        await restore();
        await rename("customers", "customers_hidden");
        await call(H.me, { token: L2.token });
        const s2 = await call(H.loginStart, { method: "POST", body: { phone: c.phone } });
        await call(H.loginVerify, { method: "POST", body: { challengeId: s2.body.challengeId, code: "000000", email: c.email } });
        await call(H.profile, { method: "PATCH", token: L2.token, body: { email: c.email } });
        await restore();
        await rename("customer_sessions", "customer_sessions_hidden");
        await call(H.me, { token: L2.token });
        const s3 = await call(H.loginStart, { method: "POST", body: { phone: c.phone } });
        await call(H.loginVerify, { method: "POST", body: { challengeId: s3.body.challengeId, code: "000000" } });
        await call(H.logout, { method: "POST", token: L2.token });
        await restore();
      } finally {
        await restore();
      }

      // provider not configured -> one-shot warning + 503
      const prev = process.env.OTP_PROVIDER;
      delete process.env.OTP_PROVIDER;
      resetOtpProviderCache();
      try {
        await call(H.loginStart, { method: "POST", body: { phone: c.phone } });
      } finally {
        process.env.OTP_PROVIDER = prev;
        resetOtpProviderCache();
      }
    });

    if (process.env.ACCOUNTS_TEST_DEBUG) console.log("captured log lines:\n" + lines.map((l) => "  | " + l.split("\n")[0]).join("\n"));
    ok(lines.length >= 5, `the failure paths did log something (the scan is meaningful): ${lines.length}`);
    const blob = lines.join("\n");
    const digitsOnly = blob.replace(/\D/g, "");
    const forbidden = [c.phone, c.phoneFormatted, "3339876543", c.email, "log.leak.check", "Leak Check", ...tokens, "mock:+92"];
    for (const f of forbidden) ok(!blob.includes(f), `log output must not contain ${f.length > 12 ? f.slice(0, 6) + "…" : f}`);
    ok(!digitsOnly.includes("3339876543"), "no phone digits even after stripping punctuation");
    ok(!/(?<!\d)(111111|000000)(?!\d)/.test(blob), "no OTP code values in logs");
    ok(!/[0-9a-f]{64}/i.test(blob), "no 64-hex tokens / hashes in logs");
    ok(lines.some((l) => l.includes("[api/account/")), "route failure lines carry only a route tag + error code");
  });

  /* 16 ------------------------------------------------------------ */
  await section("16. RBAC: settings:accounts is super_admin only (site-content write + admin-accounts-settings GET)", async () => {
    const tokens = {
      writer: await mintToken("writer"),
      manager: await mintToken("manager"),
      super_admin: await mintToken("super_admin"),
    };
    const flagRow = () => one(pool, "SELECT content_value FROM site_content WHERE content_key = 'accounts_enabled'");
    const write = (token, body, extra = {}) => admin(siteContentHandler, token, { method: "POST", url: "/api/site-content", body, ...extra });

    // flag defaults off: the account API 404s until a super_admin turns it on
    eq((await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone } })).statusCode, 404);

    // anonymous / writer / manager cannot write the flag, in any shape (single key or batched updates)
    const attempts = [
      { key: "accounts_enabled", value: "1" },
      { updates: [{ key: "accounts_enabled", value: "1" }] },
      { updates: [{ key: "hero_title", value: "ok" }, { key: "accounts_enabled", value: "1" }] },
    ];
    for (const body of attempts) {
      const none = await write(null, body);
      eq(none.statusCode, 401, `anonymous ${JSON.stringify(body).slice(0, 40)}`);
      for (const role of ["writer", "manager"]) {
        const r = await write(tokens[role], body);
        eq(r.statusCode, 403, `${role} ${JSON.stringify(body).slice(0, 50)} -> ${r.statusCode}`);
        eq(r.body, { error: "Forbidden" });
      }
    }
    eq(await flagRow(), undefined, "no flag row written by non-super_admin");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM site_content WHERE content_key = 'hero_title'"), 0, "a mixed batch writes nothing for a forbidden caller");
    // arbitrary-key upsert / delete is super_admin-only already
    for (const role of ["writer", "manager"]) {
      eq((await admin(siteContentHandler, tokens[role], { method: "PUT", url: "/api/site-content", body: { content_key: "accounts_enabled", content_value: "1" } })).statusCode, 403, `${role} PUT`);
      eq((await admin(siteContentHandler, tokens[role], { method: "DELETE", url: "/api/site-content", query: { key: "accounts_enabled" } })).statusCode, 403, `${role} DELETE`);
    }
    eq(await flagRow(), undefined);

    // admin-accounts-settings read: none 401, writer/manager 403, super_admin 200
    eq((await admin(adminAccountsSettingsHandler, null, { url: "/api/admin-accounts-settings" })).statusCode, 401);
    for (const role of ["writer", "manager"]) {
      const r = await admin(adminAccountsSettingsHandler, tokens[role], { url: "/api/admin-accounts-settings" });
      eq(r.statusCode, 403, `${role} GET admin-accounts-settings`);
      eq(r.body, { error: "Forbidden" });
    }
    const off = await admin(adminAccountsSettingsHandler, tokens.super_admin, { url: "/api/admin-accounts-settings" });
    eq(off.statusCode, 200, JSON.stringify(off.body));
    eq(off.body, { success: true, settings: { accounts_enabled: false }, otpProviderConfigured: true, customerEmails: { received: false, confirmed: false } });
    eq(off.headers["cache-control"], "no-store");
    ok(!JSON.stringify(off.body).includes("mock"), "provider name is never exposed");
    eq((await admin(adminAccountsSettingsHandler, tokens.super_admin, { method: "POST", url: "/api/admin-accounts-settings", body: { accounts_enabled: "1" } })).statusCode, 405, "read-only endpoint");

    // super_admin: validation, cross-origin guard, then a real write that flips the live gate immediately
    for (const value of ["2", "true", "", "yes", "-1"]) {
      const r = await write(tokens.super_admin, { key: "accounts_enabled", value });
      eq(r.statusCode, 400, `invalid value ${JSON.stringify(value)}`);
    }
    eq(await flagRow(), undefined, "invalid values stored nothing");
    const xo = await write(tokens.super_admin, { key: "accounts_enabled", value: "1" }, { headers: { origin: "http://evil.test" } });
    eq(xo.statusCode, 403, "cross-origin write refused");
    eq(await flagRow(), undefined);

    const on = await write(tokens.super_admin, { key: "accounts_enabled", value: "1" });
    eq(on.statusCode, 200, JSON.stringify(on.body));
    eq((await flagRow()).content_value, "1");
    const live = await call(H.loginStart, { method: "POST", body: { phone: newPerson().phone } });
    eq(live.statusCode, 200, "gate flipped on immediately (cache reset by the write)");
    const read = await admin(adminAccountsSettingsHandler, tokens.super_admin, { url: "/api/admin-accounts-settings" });
    eq(read.body.settings, { accounts_enabled: true });

    // batch form by super_admin, and back off
    const batch = await write(tokens.super_admin, { updates: [{ key: "accounts_enabled", value: "0" }] });
    eq(batch.statusCode, 200);
    eq((await flagRow()).content_value, "0");
    eq((await call(H.me, {})).statusCode, 404, "off again -> 404 (not 401)");

    // customer and admin sessions never cross
    await setAccounts("1");
    const cust = await login(newPerson());
    eq((await admin(adminAccountsSettingsHandler, cust.token, { url: "/api/admin-accounts-settings" })).statusCode, 401, "customer token as admin cookie");
    const custAsCookie = await invoke(adminAccountsSettingsHandler, {
      method: "GET",
      url: "/api/admin-accounts-settings",
      cookies: { sCustomerSession: cust.token },
      headers: { origin: "http://orders.test" },
    });
    eq(custAsCookie.statusCode, 401, "customer cookie is not an admin session");
    eq((await call(H.me, { cookies: { sAdminSession: tokens.super_admin } })).statusCode, 401, "admin cookie is not a customer session");
    eq((await call(H.me, { token: tokens.super_admin })).statusCode, 401, "admin token under the customer cookie name");
    eq((await write(cust.token, { key: "accounts_enabled", value: "0" })).statusCode, 401, "customer token cannot write site-content");
    eq((await flagRow()).content_value, "1");
  });
} catch (e) {
  failure = e;
} finally {
  for (const t of ["customer_addresses", "customer_wishlist", "order_items", "customers", "customer_sessions"]) {
    await pool.query(`RENAME TABLE ${t}_hidden TO ${t}`).catch(() => {});
  }
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("FAILED:", failure.message);
  if (failure.stack) console.error(failure.stack.split("\n").slice(1, 6).join("\n"));
  console.error(`passed sections: ${sections.length}`);
  process.exit(1);
}
console.log(`accounts-db: ${sections.length} sections, ${total()} assertions — all green`);
for (const s of sections) console.log(`  ✔ ${s}`);
