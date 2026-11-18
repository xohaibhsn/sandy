/**
 * Customer auth sessions (BATCH-09) — unit/DB test against sandy_mig_orders (127.0.0.1:3307).
 *
 * lib/customerAuth.ts: hashCustomerSessionToken, createCustomerSession (rotation), getCustomerSession,
 * destroyCustomerSession, revokeAllCustomerSessions, cookie helpers, same-origin guard, and the
 * guarantee that customer and admin sessions never mix.
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)   NODE_ENV=test
 * Run: node tests/customer-auth-session.test.mjs   (shared DB: do not run in parallel with other orders tests)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  count,
  createPool,
  importFromRoot,
  installTsResolveHook,
  makeAssertions,
  makeRes,
  mintAdminToken,
  one,
  rebuildFromMigrations,
  requirePassword,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";
delete process.env.NEXT_PUBLIC_SITE_URL;
delete process.env.SITE_URL;

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const auth = await importFromRoot("lib/customerAuth.ts");
const adminAuth = await importFromRoot("lib/adminAuth.ts");
const {
  CUSTOMER_SESSION_COOKIE_NAME,
  CUSTOMER_SESSION_MAX_AGE_SEC,
  clearCustomerSessionCookie,
  createCustomerSession,
  destroyCustomerSession,
  getCustomerSession,
  hashCustomerSessionToken,
  requireCustomer,
  requireSameOriginCustomerRequest,
  revokeAllCustomerSessions,
  setCustomerSessionCookie,
} = auth;

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
async function section(name, fn) {
  try {
    await pool.query("DELETE FROM customer_sessions");
    await pool.query("DELETE FROM admin_sessions").catch(() => {});
    await fn();
    sections.push(name);
    console.log(`  ✔ ${name}`);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

async function makeCustomer(phoneNorm, status = "active") {
  const [r] = await pool.query("INSERT INTO customers (phone_norm, name, status) VALUES (?, ?, ?)", [phoneNorm, "T " + phoneNorm, status]);
  return Number(r.insertId);
}
const reqWith = (cookies = {}, extra = {}) => ({ method: "GET", headers: { host: "orders.test" }, cookies, socket: {}, ...extra });
const sessionCount = (customerId) =>
  customerId === undefined
    ? count(pool, "SELECT COUNT(*) AS c FROM customer_sessions")
    : count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE customer_id = ?", [customerId]);

let failure = null;
try {
  console.log("customer-auth-session");

  await section("hashCustomerSessionToken: sha256 hex, deterministic, never the raw token", async () => {
    const h = hashCustomerSessionToken("abc");
    eq(h, crypto.createHash("sha256").update("abc").digest("hex"));
    ok(/^[0-9a-f]{64}$/.test(h));
    eq(hashCustomerSessionToken("abc"), h, "deterministic");
    ok(hashCustomerSessionToken("abd") !== h, "different input -> different hash");
    ok(h !== "abc");
  });

  await section("cookie name + attributes (HttpOnly, SameSite=Lax, Path=/, 30d, no Secure under test)", async () => {
    eq(CUSTOMER_SESSION_COOKIE_NAME, "sCustomerSession");
    ok(CUSTOMER_SESSION_COOKIE_NAME !== "sAdminSession", "distinct from admin cookie name");
    eq(CUSTOMER_SESSION_MAX_AGE_SEC, 30 * 24 * 60 * 60);
    const raw = "a".repeat(64);
    const res = makeRes();
    setCustomerSessionCookie(res, raw);
    const c = res.headers["set-cookie"];
    ok(c.startsWith(`sCustomerSession=${raw};`), c.slice(0, 30));
    for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 24 * 60 * 60}`]) ok(c.includes(part), part);
    ok(!c.includes("Secure"), "no Secure flag outside production/https");
    const cleared = makeRes();
    clearCustomerSessionCookie(cleared);
    const cc = cleared.headers["set-cookie"];
    ok(cc.startsWith("sCustomerSession=;"), "cleared value is empty");
    ok(cc.includes("Max-Age=0") && cc.includes("HttpOnly") && cc.includes("Path=/"));

    // https site URL -> Secure
    process.env.NEXT_PUBLIC_SITE_URL = "https://shop.example.test";
    const secure = makeRes();
    setCustomerSessionCookie(secure, raw);
    ok(secure.headers["set-cookie"].includes("; Secure"), "Secure when site is https");
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  await section("create: 32-byte hex token; only the hash is stored; ~30 day expiry", async () => {
    const id = await makeCustomer("03330001001");
    const raw = await createCustomerSession(id);
    ok(/^[0-9a-f]{64}$/.test(raw), "64 hex chars");
    const row = await one(pool, "SELECT token_hash, customer_id, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS ttl FROM customer_sessions");
    eq(row.token_hash, hashCustomerSessionToken(raw));
    ok(row.token_hash !== raw, "raw token is never stored");
    eq(Number(row.customer_id), id);
    ok(Math.abs(Number(row.ttl) - CUSTOMER_SESSION_MAX_AGE_SEC) < 120, `ttl ~30d (${row.ttl})`);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE token_hash = ?", [raw]), 0);
    const raw2 = await createCustomerSession(await makeCustomer("03330001002"));
    ok(raw2 !== raw, "tokens are unique");
  });

  await section("verify: valid cookie -> customer; missing / malformed / unknown -> null without error", async () => {
    const id = await makeCustomer("03330002001");
    const raw = await createCustomerSession(id);
    const good = await getCustomerSession(reqWith({ sCustomerSession: raw }));
    eq(good.error, false);
    eq(good.customer.id, id);
    eq(good.customer.phone_norm, "03330002001");
    eq(good.customer.status, "active");

    eq(await getCustomerSession(reqWith({})), { customer: null, error: false }, "no cookie");
    eq(await getCustomerSession({ headers: {} }), { customer: null, error: false }, "no cookies object at all");
    for (const bad of ["", "   ", "short", "z".repeat(64), "a".repeat(63), "a".repeat(65), raw + "x", 123, null]) {
      eq(await getCustomerSession(reqWith({ sCustomerSession: bad })), { customer: null, error: false }, `bad cookie ${String(bad).slice(0, 8)}`);
    }
    eq(
      await getCustomerSession(reqWith({ sCustomerSession: crypto.randomBytes(32).toString("hex") })),
      { customer: null, error: false },
      "well-formed but unknown token"
    );
    const upper = await getCustomerSession(reqWith({ sCustomerSession: ` ${raw} ` }));
    eq(upper.customer?.id, id, "surrounding whitespace is trimmed");
  });

  await section("expire: expired session is rejected and purged on the next create", async () => {
    const id = await makeCustomer("03330003001");
    const raw = await createCustomerSession(id);
    await pool.query("UPDATE customer_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE customer_id = ?", [id]);
    eq(await getCustomerSession(reqWith({ sCustomerSession: raw })), { customer: null, error: false }, "expired -> null");
    eq(await sessionCount(id), 1, "row still there until purge");

    const other = await makeCustomer("03330003002");
    await pool.query("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 1 DAY))", [
      hashCustomerSessionToken("old"),
      other,
    ]);
    await createCustomerSession(other);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE token_hash = ?", [hashCustomerSessionToken("old")]), 0, "expired row purged");
    eq(await sessionCount(id), 0, "expired row for the first customer purged as well");
  });

  await section("revoke: destroyCustomerSession deletes the row and clears the cookie; idempotent", async () => {
    const id = await makeCustomer("03330004001");
    const other = await makeCustomer("03330004002");
    const raw = await createCustomerSession(id);
    const rawOther = await createCustomerSession(other);

    const res = makeRes();
    await destroyCustomerSession(reqWith({ sCustomerSession: raw }), res);
    ok(res.headers["set-cookie"].includes("Max-Age=0"), "cookie cleared");
    eq(await sessionCount(id), 0);
    eq(await getCustomerSession(reqWith({ sCustomerSession: raw })), { customer: null, error: false });
    eq((await getCustomerSession(reqWith({ sCustomerSession: rawOther }))).customer?.id, other, "other customer untouched");

    const again = makeRes();
    await destroyCustomerSession(reqWith({ sCustomerSession: raw }), again);
    ok(again.headers["set-cookie"].includes("Max-Age=0"), "second logout still clears the cookie");
    const noCookie = makeRes();
    await destroyCustomerSession(reqWith({}), noCookie);
    ok(noCookie.headers["set-cookie"].includes("Max-Age=0"), "logout without cookie still clears");
    eq(await sessionCount(other), 1);
  });

  await section("rotation: creating a session deletes the prior one(s) for that customer only", async () => {
    const id = await makeCustomer("03330005001");
    const other = await makeCustomer("03330005002");
    const rawOther = await createCustomerSession(other);
    const first = await createCustomerSession(id);
    // simulate a stray second session for the same customer
    await pool.query("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", [
      hashCustomerSessionToken("stray"),
      id,
    ]);
    eq(await sessionCount(id), 2);
    const second = await createCustomerSession(id);
    ok(first !== second);
    eq(await sessionCount(id), 1, "exactly one session after rotation");
    eq(await getCustomerSession(reqWith({ sCustomerSession: first })), { customer: null, error: false }, "old token dead");
    eq((await getCustomerSession(reqWith({ sCustomerSession: second }))).customer?.id, id, "new token live");
    eq((await getCustomerSession(reqWith({ sCustomerSession: rawOther }))).customer?.id, other, "other customer's session unaffected");
  });

  await section("revokeAllCustomerSessions removes every session of one customer", async () => {
    const id = await makeCustomer("03330006001");
    const other = await makeCustomer("03330006002");
    await createCustomerSession(other);
    await createCustomerSession(id);
    await pool.query("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", [
      hashCustomerSessionToken("x2"),
      id,
    ]);
    await revokeAllCustomerSessions(id);
    eq(await sessionCount(id), 0);
    eq(await sessionCount(other), 1);
  });

  await section("disabled customer: session is rejected and deleted", async () => {
    const id = await makeCustomer("03330007001");
    const raw = await createCustomerSession(id);
    await pool.query("UPDATE customers SET status = 'disabled' WHERE id = ?", [id]);
    eq(await getCustomerSession(reqWith({ sCustomerSession: raw })), { customer: null, error: false });
    eq(await sessionCount(id), 0, "session row removed");
    // a customer deleted out from under a session also yields null (inner join)
    const id2 = await makeCustomer("03330007002");
    const raw2 = await createCustomerSession(id2);
    await pool.query("DELETE FROM customers WHERE id = ?", [id2]);
    eq(await getCustomerSession(reqWith({ sCustomerSession: raw2 })), { customer: null, error: false });
  });

  await section("never mixes with admin sessions (cookie names, tables, token hashes)", async () => {
    const custId = await makeCustomer("03330008001");
    const custRaw = await createCustomerSession(custId);
    const adminRaw = await mintAdminToken(pool);

    // admin token presented as a customer cookie -> not a customer
    eq(await getCustomerSession(reqWith({ sCustomerSession: adminRaw })), { customer: null, error: false });
    // admin cookie alone -> not a customer
    eq(await getCustomerSession(reqWith({ sAdminSession: adminRaw })), { customer: null, error: false });
    // customer token presented as an admin cookie -> not an admin
    const asAdmin = await adminAuth.getAdminSession(reqWith({ sAdminSession: custRaw }));
    eq(asAdmin.session ?? null, null, "customer token is not an admin session");
    // customer token under the admin cookie name is invisible to the customer lookup
    eq(await getCustomerSession(reqWith({ sAdminSession: custRaw })), { customer: null, error: false });
    // both cookies present: each side only reads its own
    const both = reqWith({ sAdminSession: adminRaw, sCustomerSession: custRaw });
    eq((await getCustomerSession(both)).customer?.id, custId);
    eq((await adminAuth.getAdminSession(both)).session?.role, "super_admin");

    // storage is separate
    eq(await count(pool, "SELECT COUNT(*) AS c FROM admin_sessions WHERE token_hash = ?", [hashCustomerSessionToken(custRaw)]), 0);
    eq(await count(pool, "SELECT COUNT(*) AS c FROM customer_sessions WHERE token_hash = ?", [hashCustomerSessionToken(adminRaw)]), 0);

    // logging out a customer must not touch admin sessions
    const adminRows = await count(pool, "SELECT COUNT(*) AS c FROM admin_sessions");
    await destroyCustomerSession(reqWith({ sCustomerSession: custRaw }), makeRes());
    eq(await count(pool, "SELECT COUNT(*) AS c FROM admin_sessions"), adminRows);
  });

  await section("requireCustomer: 401 without session, 403 cross-origin, 200 path returns the customer", async () => {
    const id = await makeCustomer("03330009001");
    const raw = await createCustomerSession(id);
    const origin = { origin: "http://orders.test" };

    const r401 = makeRes();
    eq(await requireCustomer(reqWith({}), r401), null);
    eq(r401.statusCode, 401);

    const okRes = makeRes();
    const me = await requireCustomer(reqWith({ sCustomerSession: raw }), okRes);
    eq(me.id, id);
    eq(okRes.statusCode, 200, "no status written on success");

    // unsafe method needs same-origin
    const noOrigin = makeRes();
    eq(await requireCustomer(reqWith({ sCustomerSession: raw }, { method: "POST" }), noOrigin), null);
    eq(noOrigin.statusCode, 403);
    const evil = makeRes();
    eq(await requireCustomer(reqWith({ sCustomerSession: raw }, { method: "POST", headers: { host: "orders.test", origin: "http://evil.test" } }), evil), null);
    eq(evil.statusCode, 403);
    const same = makeRes();
    eq((await requireCustomer(reqWith({ sCustomerSession: raw }, { method: "POST", headers: { host: "orders.test", ...origin } }), same)).id, id);
  });

  await section("requireSameOriginCustomerRequest: safe methods pass; Origin/Referer/Sec-Fetch-Site rules", async () => {
    const check = (headers, method = "POST") => {
      const res = makeRes();
      const allowed = requireSameOriginCustomerRequest({ method, headers }, res);
      return { allowed, status: res.statusCode };
    };
    eq(check({}, "GET").allowed, true);
    eq(check({}, "HEAD").allowed, true);
    eq(check({ host: "orders.test", origin: "http://orders.test" }).allowed, true);
    eq(check({ host: "orders.test", referer: "http://orders.test/account" }).allowed, true, "Referer fallback");
    eq(check({ host: "orders.test" }), { allowed: false, status: 403 }, "no provenance");
    eq(check({ host: "orders.test", origin: "null" }).allowed, false);
    eq(check({ host: "orders.test", origin: "http://evil.test" }).allowed, false);
    eq(check({ host: "orders.test", origin: "http://orders.test", "sec-fetch-site": "cross-site" }).allowed, false);
    eq(check({ origin: "http://orders.test" }).allowed, false, "missing host");
    eq(check({ host: "orders.test", origin: "http://orders.test", "x-forwarded-proto": "https" }).allowed, false, "scheme mismatch behind https proxy");
    eq(check({ host: "orders.test", origin: "https://orders.test", "x-forwarded-proto": "https" }).allowed, true);
  });
} catch (e) {
  failure = e;
} finally {
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("FAILED:", failure.message);
  if (failure.stack) console.error(failure.stack.split("\n").slice(1, 6).join("\n"));
  console.error(`passed sections: ${sections.length}`);
  process.exit(1);
}
console.log(`customer-auth-session: ${sections.length} sections, ${total()} assertions — all green`);
