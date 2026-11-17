/**
 * SANDY-BATCH-05 Phase 2 — POST /api/track phone matching (no database, no network).
 *
 * The REAL handler (pages/api/track.ts) is invoked with fake req/res objects and a fake pool that serves one stored order.
 * Pakistani mobile numbers are canonicalised on both sides (0333..., +92333..., 92333..., 0092333..., 333...),
 * anything else keeps the exact-digits rule. Rate limits and response shapes are unchanged.
 *
 * Run: node tests/track-phone.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.removeAllListeners("warning");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

let storedPhone = "03331234567";
const STORED_EMAIL = "buyer@example.test";
const created = new Date("2026-03-10T09:00:00Z");
let queries = 0;

globalThis._mysqlPool = {
  query: async (sql) => {
    queries += 1;
    const text = String(sql);
    if (/SHOW COLUMNS FROM orders/i.test(text)) return [[], []];
    if (/FROM orders/i.test(text)) {
      return [
        [
          {
            order_id: "ORD-1",
            status: "pending",
            created_at: created,
            total: "1179.00",
            vat_amount: "180.00",
            customer_email: STORED_EMAIL,
            customer_phone: storedPhone,
          },
        ],
        [],
      ];
    }
    if (/FROM order_items/i.test(text)) return [[{ product_name: "Phone Case", price: "999.00", quantity: 1 }], []];
    if (/FROM order_tax_snapshots/i.test(text)) return [[{ tax_label: "GST" }], []];
    return [[], []];
  },
};

const { __rateLimitTestUtils } = await import(pathToFileURL(path.join(root, "lib/rateLimit.ts")).href);
const handler = (await import(pathToFileURL(path.join(root, "pages/api/track.ts")).href)).default;

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};

async function track(body, { ip = "203.0.113.90", method = "POST", keepLimits = false } = {}) {
  if (!keepLimits) __rateLimitTestUtils.clearStore();
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await handler(
    {
      method,
      url: "/api/track",
      query: {},
      headers: { host: "track.test", "x-forwarded-for": ip },
      cookies: {},
      body,
      socket: { remoteAddress: "127.0.0.1" },
    },
    res
  );
  return res;
}

const FAIL = { error: "Order not found or details do not match" };
const results = [];

async function expectMatch(stored, provided, label) {
  storedPhone = stored;
  const res = await track({ order_id: "ORD-1", phone: provided });
  eq(res.statusCode, 200, `${label}: stored=${stored} provided=${provided} -> ${res.statusCode}`);
}
async function expectNoMatch(stored, provided, label) {
  storedPhone = stored;
  const res = await track({ order_id: "ORD-1", phone: provided });
  eq(res.statusCode, 404, `${label}: stored=${stored} provided=${provided} -> ${res.statusCode}`);
  eq(res.body, FAIL, `${label}: generic failure body`);
}

// ---------------------------------------------------------------- PK mobile: every spelling matches stored 03XXXXXXXXX
for (const stored of ["03331234567", "0333-1234567", "0333 1234567", "+92 333 1234567", "+923331234567", "923331234567", "00923331234567", "3331234567"]) {
  for (const provided of [
    "03331234567",
    "0333 1234567",
    "0333-1234567",
    "+92333 1234567",
    "+92 333 1234567",
    "+923331234567",
    "923331234567",
    "0092333 1234567",
    "00923331234567",
    "3331234567",
    "333 1234567",
  ]) {
    await expectMatch(stored, provided, "PK both sides");
  }
}
results.push("PK mobile: 0333 / +92333 / 92333 / 0092333 / 333 all match each stored spelling (both sides canonicalised)");

// ---------------------------------------------------------------- PK mobile: wrong numbers fail
for (const stored of ["03331234567", "+92 333 1234567"]) {
  for (const provided of [
    "03331234568", // last digit
    "0334 1234567", // different network code
    "923331234568",
    "+92 333 1234568",
    "00923331234568",
    "3331234568",
    "03321234567",
    "03001234567",
    "033312345678", // one digit too many
    "0333123456", // one digit too few
    "3331234", // truncated
    "1234567", // tail only
  ]) {
    await expectNoMatch(stored, provided, "PK wrong");
  }
}
results.push("PK mobile: wrong / truncated / extended numbers fail with the generic 404");

// ---------------------------------------------------------------- non-PK: exact digits rule exactly as before
await expectMatch("+44 7700 900123", "447700900123", "UK exact");
await expectMatch("+44 7700 900123", "+44 7700-900123", "UK exact, formatting ignored");
await expectNoMatch("+44 7700 900123", "07700900123", "UK national form is NOT canonicalised");
await expectNoMatch("+44 7700 900123", "7700900123", "UK tail only");
await expectMatch("12345", "12345", "short exact");
await expectNoMatch("12345", "012345", "short with leading zero differs");
await expectMatch("0211234567", "0211234567", "PK landline exact"); // 02..., not a mobile
await expectNoMatch("0211234567", "+92211234567", "PK landline is not canonicalised");
await expectNoMatch("0211234567", "211234567", "PK landline tail only");
await expectMatch("923001234567890", "923001234567890", "too long for PK mobile -> exact");
await expectNoMatch("923001234567890", "03001234567890", "too long for PK mobile, no rewrite");
// mixed: one side PK mobile, the other not -> exact rule (which cannot match a different spelling)
await expectNoMatch("03331234567", "13331234567", "provided is not a PK mobile");
await expectNoMatch("13331234567", "03331234567", "stored is not a PK mobile");
await expectNoMatch("03331234567", "+92 0333 1234567", "extra 0 after +92 is not a recognised spelling");
results.push("non-PK / mixed: exact-digits rule unchanged (no rewriting)");

// ---------------------------------------------------------------- email path, response shape, privacy unchanged
storedPhone = "03331234567";
{
  const byEmail = await track({ order_id: "ORD-1", email: STORED_EMAIL.toUpperCase() });
  eq(byEmail.statusCode, 200);
  const byPhone = await track({ order_id: "ORD-1", phone: "+92 333 1234567" });
  eq(byPhone.statusCode, 200);
  eq(Object.keys(byPhone.body).sort(), ["items", "order"]);
  eq(Object.keys(byPhone.body.order).sort(), ["created_at", "order_id", "status", "tax_label", "total", "vat_amount"]);
  eq(byPhone.body.items, [{ product_name: "Phone Case", quantity: 1, price: "999.00" }]);
  eq(byPhone.body, byEmail.body, "same payload whichever verifier matched");
  eq(byPhone.headers["cache-control"], "private, no-store, max-age=0");
  // wrong phone but right email still succeeds (either verifier is enough, as before)
  const mixed = await track({ order_id: "ORD-1", email: STORED_EMAIL, phone: "03339999999" });
  eq(mixed.statusCode, 200);
  const none = await track({ order_id: "ORD-1", email: "other@example.test", phone: "03339999999" });
  eq(none.statusCode, 404);
  eq(none.body, FAIL);
  eq((await track({ order_id: "ORD-1" })).statusCode, 404, "no verifier");
  eq((await track({ order_id: "ORD-1", phone: "abc" })).statusCode, 404, "no digits");
  eq((await track({ order_id: "ORD-1", phone: "+92 333 1234567" }, { method: "GET" })).statusCode, 405);
  results.push("response shape, email verifier, privacy headers and 404 body unchanged");
}

// ---------------------------------------------------------------- no stored phone
{
  storedPhone = "";
  eq((await track({ order_id: "ORD-1", phone: "03331234567" })).statusCode, 404, "empty stored phone never matches");
  storedPhone = null;
  eq((await track({ order_id: "ORD-1", phone: "03331234567" })).statusCode, 404, "null stored phone never matches");
  results.push("empty / null stored phone never matches");
}

// ---------------------------------------------------------------- rate limit unchanged (15 / 15 min / IP)
{
  storedPhone = "03331234567";
  __rateLimitTestUtils.clearStore();
  let last;
  for (let i = 1; i <= 16; i += 1) {
    last = await track({ order_id: "ORD-1", phone: "03339999999" }, { ip: "203.0.113.91", keepLimits: true });
    if (i <= 15) eq(last.statusCode, 404, `attempt ${i}`);
  }
  eq(last.statusCode, 429);
  eq(last.body, { error: "Too many requests. Please try again later." });
  results.push("rate limit unchanged (15 attempts, then 429)");
}

console.log(`track-phone: OK ${results.length} sections, ${assertions} assertions, ${queries} fake queries`);
for (const r of results) console.log(`  - ${r}`);
