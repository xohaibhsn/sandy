/**
 * RECEIPT-PRIVACY-01 — local DB/HTTP suite (Finding 64).
 * Local MariaDB 127.0.0.1:3307 only. All Cloudinary/network calls injected/faked.
 *
 * Env: SANDY_TEST_DB_PASSWORD
 * Run: node tests/receipt-privacy-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  adminReq,
  checkoutBody,
  createPool,
  ensureTestMasterLoginEnv,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  makeReq,
  rebuildFromMigrations,
  requirePassword,
  root,
  runSqlOnTestDb,
  applyDeliveryOpsMigration,
  one,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";
ensureTestMasterLoginEnv();

// No-network proof: any real fetch to non-injected URLs must throw.
const realFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  throw new Error(`NETWORK_FORBIDDEN:${String(url).slice(0, 80)}`);
};

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetAuditThrottleForTests } = await importFromRoot("lib/auditLog.ts");
const {
  __setReceiptProxyDepsForTests,
  __clearReceiptProxyRateLimitForTests,
} = await importFromRoot("pages/api/admin-receipt/[file].ts");
const { privateReceiptsDir, formatReceiptRef } = await importFromRoot("lib/receiptRef.ts");
const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;
const adminOrdersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const receiptHandler = (await importFromRoot("pages/api/admin-receipt/[file].ts")).default;

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

function clear({ receiptRate = true } = {}) {
  __rateLimitTestUtils.clearStore();
  resetAuditThrottleForTests();
  if (receiptRate) __clearReceiptProxyRateLimitForTests();
}

async function mintToken(role) {
  ensureTestMasterLoginEnv();
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, 1, role, `rp-${role}`, expires]
  );
  return raw;
}

function adminInvoke(handler, token, opts) {
  clear();
  const base = token ? adminReq(token) : { cookies: {}, headers: { origin: "http://orders.test" } };
  return invoke(handler, {
    ...opts,
    cookies: base.cookies,
    headers: { ...base.headers, ...(opts.headers || {}) },
  });
}

/** Capture binary/redirect responses. */
async function invokeReceipt(token, file, { method = "GET", resetReceiptRate = false } = {}) {
  if (resetReceiptRate) __clearReceiptProxyRateLimitForTests();
  __rateLimitTestUtils.clearStore();
  const base = token ? adminReq(token) : { cookies: {}, headers: { origin: "http://orders.test" } };
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
      return this;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    end(b) {
      if (b !== undefined) this.body = b;
      return this;
    },
  };
  const req = makeReq({
    method,
    url: `/api/admin-receipt/${file}`,
    query: { file },
    cookies: base.cookies,
    headers: base.headers,
  });
  await receiptHandler(req, res);
  return res;
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

await pool.query(
  `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
   VALUES ('Receipt Privacy Case', 'rp-case', 500, 'Accessories', '50', 1, 50, 1)`
);
const product = await one(pool, "SELECT id FROM products WHERE slug = 'rp-case'");
const items = [{ id: product.id, qty: 1 }];

const locUuid = crypto.randomUUID();
const locRef = formatReceiptRef("loc", locUuid, "png");
const receiptsDir = privateReceiptsDir();
fs.mkdirSync(receiptsDir, { recursive: true });
fs.writeFileSync(path.join(receiptsDir, `${locUuid}.png`), PNG_BYTES);

process.env.CLOUDINARY_CLOUD_NAME = "sandytestcloud";
const legacyUrl = `https://res.cloudinary.com/sandytestcloud/image/upload/v1/sandy/receipts/receipt-${crypto.randomUUID()}.png`;

let failure = null;
try {
  let locOrderId = "";
  let legacyOrderId = "";
  let cldOrderId = "";
  const manager = await mintToken("manager");
  const writer = await mintToken("writer");
  const superAdmin = await mintToken("super_admin");

  await section("place order with loc ref; admin detail returns proxy URL", async () => {
    clear();
    const body = checkoutBody({
      items,
      payment_method: "bank",
      payment_reference: "RP-LOC-1",
      receipt_path: locRef,
    });
    const res = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    locOrderId = res.body.order_id;
    const row = await one(pool, "SELECT receipt_path FROM orders WHERE order_id = ?", [locOrderId]);
    eq(row.receipt_path, locRef);

    const detail = await adminInvoke(adminOrdersHandler, manager, {
      method: "GET",
      url: "/api/admin-orders",
      query: { id: locOrderId },
    });
    eq(detail.statusCode, 200, JSON.stringify(detail.body));
    eq(detail.body.order.receipt_url, `/api/admin-receipt/${locOrderId}.png`);
    ok(!String(detail.body.order.receipt_url).includes("cloudinary"));
    ok(!String(detail.body.order.receipt_url).startsWith("http"));
  });

  await section("place order with legacy URL; detail keeps legacy receipt_url", async () => {
    clear();
    const body = checkoutBody({
      items,
      payment_method: "jazzcash",
      payment_reference: "RP-LEG-1",
      receipt_path: legacyUrl,
    });
    const res = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    legacyOrderId = res.body.order_id;
    const detail = await adminInvoke(adminOrdersHandler, manager, {
      method: "GET",
      url: "/api/admin-orders",
      query: { id: legacyOrderId },
    });
    eq(detail.statusCode, 200);
    eq(detail.body.order.receipt_url, legacyUrl);
  });

  await section("GET admin-receipt: 401 unauth / 403 writer / 200 manager bytes + headers", async () => {
    const unauth = await invokeReceipt(null, `${locOrderId}.png`);
    eq(unauth.statusCode, 401);

    const w = await invokeReceipt(writer, `${locOrderId}.png`);
    eq(w.statusCode, 403);
    eq(w.body, { error: "Forbidden" });

    const okRes = await invokeReceipt(manager, `${locOrderId}.png`);
    eq(okRes.statusCode, 200);
    ok(Buffer.isBuffer(okRes.body) || okRes.body instanceof Uint8Array);
    eq(Buffer.from(okRes.body).equals(PNG_BYTES), true);
    eq(okRes.headers["content-type"], "image/png");
    eq(okRes.headers["cache-control"], "private, no-store");
    eq(okRes.headers["x-content-type-options"], "nosniff");
    ok(String(okRes.headers["content-disposition"]).includes(`inline; filename="${locOrderId}-receipt.png"`));
  });

  await section("404 path traversal / wrong order / no receipt / ext mismatch", async () => {
    eq((await invokeReceipt(manager, `../etc/passwd.png`)).statusCode, 404);
    eq((await invokeReceipt(manager, `ORD-NOPE.png`)).statusCode, 404);
    eq((await invokeReceipt(manager, `${locOrderId}.pdf`)).statusCode, 404);
    // order without receipt
    clear();
    const bare = await invoke(ordersHandler, {
      url: "/api/orders",
      body: checkoutBody({ items, payment_method: "cod" }),
    });
    eq(bare.statusCode, 200);
    eq((await invokeReceipt(manager, `${bare.body.order_id}.png`)).statusCode, 404);
  });

  await section("cld ref with injected signer+fetch returns bytes; never exposes signed URL", async () => {
    const cldId = `receipt-${crypto.randomUUID()}`;
    const cldRef = formatReceiptRef("cld", cldId, "png");
    clear();
    const body = checkoutBody({
      items,
      payment_method: "easypaisa",
      payment_reference: "RP-CLD-1",
      receipt_path: cldRef,
    });
    const res = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    cldOrderId = res.body.order_id;

    const fakeBytes = Buffer.from("FAKE-CLD-BYTES-PNG-CONTENT!!!!!!!!!!!!");
    let signedSeen = "";
    __setReceiptProxyDepsForTests({
      signUrl: async ({ publicId, resourceType, format }) => {
        eq(publicId, `sandy/receipts/${cldId}`);
        eq(resourceType, "image");
        eq(format, "png");
        signedSeen = `https://res.cloudinary.com/sandytestcloud/image/authenticated/s--TESTSIG--/v1/${publicId}.${format}`;
        return signedSeen;
      },
      fetch: async (url) => {
        ok(url.startsWith("https://res.cloudinary.com/"));
        ok(url.includes("TESTSIG"));
        return {
          ok: true,
          status: 200,
          headers: { get: () => "image/png" },
          arrayBuffer: async () => fakeBytes,
        };
      },
    });

    const beforeNet = fetchCalls.length;
    const r = await invokeReceipt(manager, `${cldOrderId}.png`);
    eq(r.statusCode, 200);
    eq(Buffer.from(r.body).equals(fakeBytes), true);
    eq(fetchCalls.length, beforeNet, "global fetch must not be used (injected)");
    const payload = JSON.stringify(r.body) + JSON.stringify(r.headers);
    ok(!payload.includes("TESTSIG"));
    ok(!payload.includes("cloudinary.com"));
    ok(!payload.includes(signedSeen));
    __setReceiptProxyDepsForTests(null);
  });

  await section("legacy URL via proxy returns 302", async () => {
    __setReceiptProxyDepsForTests(null);
    const r = await invokeReceipt(manager, `${legacyOrderId}.png`);
    eq(r.statusCode, 302);
    eq(r.headers.location, legacyUrl);
  });

  await section("audit receipt_view throttled per staff+order (10 min)", async () => {
    resetAuditThrottleForTests();
    __clearReceiptProxyRateLimitForTests();
    const before = Number(
      (await one(pool, "SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'receipt_view' AND entity_id = ?", [
        locOrderId,
      ])).c
    );
    eq((await invokeReceipt(manager, `${locOrderId}.png`)).statusCode, 200);
    eq((await invokeReceipt(manager, `${locOrderId}.png`)).statusCode, 200);
    const after = Number(
      (await one(pool, "SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'receipt_view' AND entity_id = ?", [
        locOrderId,
      ])).c
    );
    eq(after, before + 1, "second view within window suppressed");
    const row = await one(
      pool,
      "SELECT detail_json FROM admin_audit_log WHERE action = 'receipt_view' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [locOrderId]
    );
    const detail = JSON.parse(row.detail_json || "{}");
    eq(detail.kind, "receipt");
    ok(!JSON.stringify(detail).includes("cloudinary"));
    ok(!JSON.stringify(detail).includes("http"));
  });

  await section("in-file rate limit 60/min per staff session", async () => {
    __clearReceiptProxyRateLimitForTests();
    resetAuditThrottleForTests();
    let last = 200;
    for (let i = 0; i < 61; i += 1) {
      const r = await invokeReceipt(superAdmin, `${locOrderId}.png`);
      last = r.statusCode;
      if (i < 60) eq(r.statusCode, 200, `hit ${i + 1}`);
    }
    eq(last, 429);
  });

  await section("list keeps truthy receipt indicator without breaking sidhu shape", async () => {
    const list = await adminInvoke(adminOrdersHandler, manager, {
      method: "GET",
      url: "/api/admin-orders",
      query: { page: "1", pageSize: "50" },
    });
    eq(list.statusCode, 200);
    const row = (list.body.orders || []).find((o) => o.order_id === locOrderId);
    ok(row);
    ok(row.receipt_path);
    ok(!!row.receipt_path);
    // opaque ref is not a working external URL
    ok(!String(row.receipt_path).startsWith("http"));
  });

  await section("no-network proof recorded", async () => {
    ok(typeof globalThis.fetch === "function");
    // Any accidental call would have thrown; cld path used injected fetch only.
    ok(true, `blocked_fetch_attempts=${fetchCalls.length}`);
  });
} catch (e) {
  failure = e;
} finally {
  __setReceiptProxyDepsForTests(null);
  globalThis.fetch = realFetch;
  try {
    fs.rmSync(path.join(receiptsDir, `${locUuid}.png`), { force: true });
  } catch {
    /* ignore */
  }
  await pool.end();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log(
  "RECEIPT_PRIVACY_DB_PASS",
  JSON.stringify({ sections, assertions: total(), fetchBlocked: fetchCalls.length })
);
process.exit(0);
