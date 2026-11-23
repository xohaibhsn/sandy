/**
 * Customer order emails (SANDY-BATCH-48 CUSTOMER-EMAIL-01) — DB/API integration test.
 *
 * Runs the REAL pages/api handlers in-process against sandy_mig_orders (127.0.0.1:3307; schema from
 * migrations only: 0001..0009 + tax + 0011 audit log). nodemailer.createTransport is replaced by a recorder,
 * so no SMTP connection is ever made.
 *
 * Sections
 *   1  flags OFF (default): checkout sends only the store email; confirm sends nothing; no customer audit rows
 *   2  received ON: checkout -> exactly one customer email (escaped, clean subject) + store email unchanged
 *      + customer_email_sent audit {kind:"received"}; checkout response keys unchanged; idempotent replay sends nothing
 *   3  received ON, send failure: checkout still 200 (same body shape) + customer_email_failed audit; logs clean
 *   4  confirmed ON, generic path: transition sends once; second confirm / other statuses send nothing
 *   5  confirmed ON, COD protection path: transition sends once; second confirm sends nothing
 *   6  RBAC: new keys need settings:accounts (writer/manager 403, super_admin ok); admin-accounts-settings body
 *
 * Env: SANDY_TEST_DB_PASSWORD (required)  OTP_PROVIDER=mock  NODE_ENV=test
 * Run: node tests/customer-email-db.test.mjs      (do not run in parallel with other orders tests: shared DB)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import nodemailer from "nodemailer";
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
  root,
  runSqlOnTestDb,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.OTP_PROVIDER = "mock";
process.env.NODE_ENV = "test";
delete process.env.SANDY_MAIL_JSON_TRANSPORT;

await rebuildFromMigrations();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const { resetCustomerEmailSettingsCache, CUSTOMER_EMAIL_SETTINGS_KEYS } = await importFromRoot("lib/customerEmailSettings.ts");
const { resetOrderProtectionSettingsCache } = await importFromRoot("lib/orderProtectionSettings.ts");
const { resetAuditSchemaProbeForTests } = await importFromRoot("lib/auditLog.ts");
const { CONTACT_EMAIL } = await importFromRoot("lib/site.ts");
const ordersMod = await importFromRoot("pages/api/orders.ts");
const ordersHandler = ordersMod.default;
const { __resetStoreEmailSkipThrottleForTests } = ordersMod;
const adminOrdersHandler = (await importFromRoot("pages/api/admin-orders.ts")).default;
const siteContentHandler = (await importFromRoot("pages/api/site-content.ts")).default;
const adminAccountsSettingsHandler = (await importFromRoot("pages/api/admin-accounts-settings.ts")).default;

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => __rateLimitTestUtils.clearStore();

const realCreateTransport = nodemailer.createTransport;
const savedEnv = { SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS };
const sent = [];
let failSend = false;

function installMockTransport() {
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => {
      if (failSend) {
        // The error text deliberately carries recipient / subject / body: none of it may reach the logs.
        const err = new Error(`failed for ${mail.to} subject=${mail.subject} body=${mail.html}`);
        err.code = "ESOCKET";
        throw err;
      }
      sent.push(mail);
      return { messageId: "mock" };
    },
  });
}

async function waitFor(cond, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(25);
  }
  return cond();
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
    const value = await fn();
    return { lines, value };
  } finally {
    for (const m of Object.keys(saved)) console[m] = saved[m];
  }
}

/* ------------------------------------------------------------------ seed + helpers */

const HOSTILE_PRODUCT = `Mail <b>Case</b> & "x"`;
await pool.query(
  `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
   VALUES (?, 'mail-case', 1000, 'Accessories', 'In Stock', 0, NULL, 1)`,
  [HOSTILE_PRODUCT]
);
const P1 = (await one(pool, "SELECT id FROM products WHERE slug = 'mail-case'")).id;

async function setFlags(map = {}) {
  await pool.query("DELETE FROM site_content WHERE content_key IN (?)", [[...CUSTOMER_EMAIL_SETTINGS_KEYS, "cod_protection_enabled"]]);
  for (const [k, v] of Object.entries(map)) {
    await pool.query(
      "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES (?, ?, 'text', 'settings', ?)",
      [k, v, k]
    );
  }
  resetCustomerEmailSettingsCache();
  resetOrderProtectionSettingsCache();
}

async function resetAll() {
  for (const t of ["order_items", "order_tax_snapshots", "orders", "order_checkout_attempts", "admin_sessions", "admin_audit_log"]) {
    await pool.query(`DELETE FROM ${t}`);
  }
  sent.length = 0;
  failSend = false;
  process.env.SMTP_USER = "mock-user";
  process.env.SMTP_PASS = "mock-pass";
  delete process.env.MAIL_FROM;
  resetAuditSchemaProbeForTests();
  __resetStoreEmailSkipThrottleForTests();
  await setFlags({});
  installMockTransport();
  clear();
}

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

async function placeOrder(overrides = {}) {
  clear();
  await sleep(5);
  return invoke(ordersHandler, {
    url: "/api/orders",
    body: checkoutBody({ items: [{ id: P1, qty: 2 }], ...overrides }),
  });
}

const emailAudits = () =>
  pool.query("SELECT action, actor_type, entity_id, summary, detail_json FROM admin_audit_log WHERE action LIKE 'customer_email_%' ORDER BY id ASC").then(([r]) => r);

const storeAudits = () =>
  pool.query("SELECT action, actor_type, entity_id, summary, detail_json FROM admin_audit_log WHERE action LIKE 'store_email_%' ORDER BY id ASC").then(([r]) => r);

async function mintToken(role) {
  ensureTestMasterLoginEnv();
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, 1, role, `mail-${role}`, expires]
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

let orderSeq = 0;
/** Inserts an order straight into the DB (admin-orders tests). */
async function insertOrder({ method = "bank", status = "pending", email = "buyer@example.test", name = "Zed <i>Buyer</i>" } = {}) {
  orderSeq += 1;
  const orderId = `MAIL-${Date.now()}-${orderSeq}`;
  await pool.query(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, postcode,
                         payment_method, total, status, discount_amount, vat_amount)
     VALUES (?, ?, ?, '03331234567', 'Secret Street 5', 'Lahore', '54000', ?, 2300, ?, 100, 300)`,
    [orderId, name, email, method, status]
  );
  await pool.query(
    "INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?, ?, ?, 1000, 2), (?, ?, 'Cable', 100, 1)",
    [orderId, P1, HOSTILE_PRODUCT, orderId, P1]
  );
  return orderId;
}

const patchStatus = (token, orderId, status, extra = {}) =>
  admin(adminOrdersHandler, token, { method: "PATCH", url: "/api/admin-orders", body: { order_id: orderId, status, ...extra } });

const statusOf = async (orderId) => (await one(pool, "SELECT status FROM orders WHERE order_id = ?", [orderId])).status;

/* ------------------------------------------------------------------ tests */

let failure = null;
try {
  /* 1 ------------------------------------------------------------ */
  await section("1. flags OFF: store email only; confirm sends nothing; no customer audit", async () => {
    const res = await placeOrder();
    eq(res.statusCode, 200, JSON.stringify(res.body));
    ok(await waitFor(async () => sent.length === 1 && (await storeAudits()).length === 1));
    eq(sent[0].to, CONTACT_EMAIL, "store email goes to the contact address");
    ok(String(sent[0].subject).startsWith("🛍️ New Order "), "store subject unchanged");
    eq((await storeAudits())[0].action, "store_email_sent");
    eq((await storeAudits())[0].entity_id, res.body.order_id);
    eq(JSON.parse((await storeAudits())[0].detail_json || "{}"), {});
    ok(!String((await storeAudits())[0].summary + ((await storeAudits())[0].detail_json || "")).includes("@"), "no address in store audit");

    const token = await mintToken("super_admin");
    const orderId = await insertOrder();
    eq((await patchStatus(token, orderId, "confirmed")).statusCode, 200);
    await sleep(150);
    eq(sent.length, 1, "no customer email on confirm with the flag off");
    eq((await emailAudits()).length, 0, "no customer_email_* audit rows");
  });

  /* 2 ------------------------------------------------------------ */
  await section("2. received ON: one customer email, store email unchanged, audit row, replay sends nothing", async () => {
    await setFlags({ customer_email_received_enabled: "1" });
    const idem = crypto.randomUUID();
    const body = {
      customer_name: `Zed <script>alert(1)</script>`,
      customer_email: "buyer.one@example.test",
      idempotency_key: idem,
      coupon_code: undefined,
    };
    const res = await placeOrder(body);
    eq(res.statusCode, 200, JSON.stringify(res.body));
    ok(await waitFor(async () => sent.length === 2 && (await emailAudits()).length === 1), `expected store + customer email, got ${sent.length}`);

    const store = sent.find((m) => m.to === CONTACT_EMAIL);
    const customer = sent.find((m) => m.to === "buyer.one@example.test");
    ok(store && customer, "one store email and one customer email");
    ok(String(store.subject).startsWith("🛍️ New Order "), "store subject unchanged");
    ok(String(store.html).includes("New Order Received"), "store template unchanged");
    ok(!("text" in store) && !("replyTo" in store), "store message keeps exactly {from,to,subject,html}");

    eq(customer.subject, `Order received — ${res.body.order_id}`);
    ok(!/[\r\n]/.test(customer.subject), "single-line subject");
    ok(!String(customer.html).includes("<script>"), "script escaped");
    ok(String(customer.html).includes("Mail &lt;b&gt;Case&lt;/b&gt; &amp; &quot;x&quot;"), "item name escaped");
    ok(!/Street|03331234567/.test(String(customer.html) + String(customer.text)), "no phone / address");
    ok(String(customer.html).includes("https://sandy.com.pk/order-tracking"), "tracking link");
    eq(customer.replyTo, CONTACT_EMAIL, "reply-to is the store contact email");

    const [audit] = await emailAudits();
    eq(audit.action, "customer_email_sent");
    eq(audit.actor_type, "system");
    eq(audit.entity_id, res.body.order_id);
    eq(JSON.parse(audit.detail_json), { kind: "received" });
    ok(!String(audit.summary + audit.detail_json).includes("example.test"), "no address in audit");

    // response shape is unchanged by the feature
    const keys = Object.keys(res.body).sort();
    ok(keys.includes("success") && keys.includes("order_id") && keys.includes("total") && keys.includes("items"));
    ok(!keys.some((k) => /mail/i.test(k)), "no email-related field leaks into the response");

    // idempotent replay is not a new order: no further email
    sent.length = 0;
    const replay = await placeOrder({ ...body });
    eq(replay.statusCode, 200, JSON.stringify(replay.body));
    await sleep(200);
    eq(sent.length, 0, "replay of the same idempotency key sends nothing");
    eq((await emailAudits()).length, 1);

    // confirmed flag still off: confirming sends nothing
    const token = await mintToken("super_admin");
    eq((await patchStatus(token, res.body.order_id, "confirmed")).statusCode, 200);
    await sleep(150);
    eq(sent.length, 0, "confirmed email flag is independent");
  });

  /* 3 ------------------------------------------------------------ */
  await section("3. received ON + send failure: checkout unchanged, failed audit, clean logs", async () => {
    await setFlags({ customer_email_received_enabled: "1" });
    failSend = true;
    const { lines, value: res } = await captureConsole(async () => {
      const r = await placeOrder({ customer_email: "buyer.two@example.test" });
      await waitFor(async () => (await emailAudits()).length === 1);
      await sleep(100);
      return r;
    });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    ok(res.body.success === true && typeof res.body.order_id === "string", "order placed normally");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM orders WHERE order_id = ?", [res.body.order_id]), 1);
    const [audit] = await emailAudits();
    eq(audit.action, "customer_email_failed");
    eq(JSON.parse(audit.detail_json), { kind: "received" });
    const blob = lines.join("\n");
    ok(blob.includes(`[mail] send failed kind=customer_received order=${res.body.order_id} code=ESOCKET`), "one-line failure log");
    ok(!blob.includes("example.test"), "no recipient in logs");
    ok(!/Order received|Thank you for your order|New Order Received/i.test(blob), "no subject / body in logs");
  });

  /* 4 ------------------------------------------------------------ */
  await section("4. confirmed ON, generic path: real transition only", async () => {
    await setFlags({ customer_email_confirmed_enabled: "1" });
    const token = await mintToken("super_admin");
    const orderId = await insertOrder();

    const first = await patchStatus(token, orderId, "confirmed");
    eq(first.statusCode, 200, JSON.stringify(first.body));
    eq(first.body, { success: true, order_id: orderId, status: "confirmed" });
    ok(await waitFor(async () => sent.length === 1 && (await emailAudits()).length === 1));
    eq(sent[0].to, "buyer@example.test");
    eq(sent[0].subject, `Order confirmed — ${orderId}`);
    ok(String(sent[0].html).includes("Mail &lt;b&gt;Case&lt;/b&gt; &amp; &quot;x&quot;"), "snapshot items loaded server-side, escaped");
    ok(String(sent[0].html).includes("Bank Transfer"), "stored payment method label");
    ok(!/Secret Street|03331234567/.test(String(sent[0].html) + String(sent[0].text)), "no phone / address");
    eq(JSON.parse((await emailAudits())[0].detail_json), { kind: "confirmed" });

    const second = await patchStatus(token, orderId, "confirmed");
    eq(second.statusCode, 200);
    await sleep(200);
    eq(sent.length, 1, "second confirm does not resend");
    eq((await emailAudits()).length, 1);

    // other transitions never send
    const other = await insertOrder();
    eq((await patchStatus(token, other, "dispatched")).statusCode, 200);
    await sleep(150);
    eq(sent.length, 1, "dispatch sends no customer email");

    // cancelled orders cannot be confirmed -> no email
    const cancelled = await insertOrder({ status: "cancelled" });
    const blocked = await patchStatus(token, cancelled, "confirmed");
    eq(blocked.statusCode, 409);
    await sleep(150);
    eq(sent.length, 1);

    // invalid / missing customer address -> no email + skipped audit
    const noMail = await insertOrder({ email: "" });
    eq((await patchStatus(token, noMail, "confirmed")).statusCode, 200);
    ok(await waitFor(async () => (await emailAudits()).length === 2));
    eq(sent.length, 1, "no valid address, no send");
    eq((await emailAudits())[1].action, "customer_email_skipped");
    eq(JSON.parse((await emailAudits())[1].detail_json), { kind: "confirmed", reason: "invalid_email" });
  });

  /* 5 ------------------------------------------------------------ */
  await section("5. confirmed ON, COD protection path: real transition only", async () => {
    await setFlags({ customer_email_confirmed_enabled: "1", cod_protection_enabled: "1" });
    const token = await mintToken("super_admin");
    const orderId = await insertOrder({ method: "cod" });

    const first = await patchStatus(token, orderId, "confirmed", { confirmation_method: "call" });
    eq(first.statusCode, 200, JSON.stringify(first.body));
    eq(first.body, { success: true, order_id: orderId, status: "confirmed" });
    eq(await statusOf(orderId), "confirmed");
    ok(await waitFor(async () => sent.length === 1 && (await emailAudits()).length === 1));
    eq(sent[0].subject, `Order confirmed — ${orderId}`);
    ok(String(sent[0].html).includes("Cash on Delivery"));

    const second = await patchStatus(token, orderId, "confirmed", { confirmation_method: "call" });
    eq(second.statusCode, 200, JSON.stringify(second.body));
    await sleep(200);
    eq(sent.length, 1, "re-confirming a COD order does not resend");

    // missing confirmation_method is rejected before any write/email
    const other = await insertOrder({ method: "cod" });
    eq((await patchStatus(token, other, "confirmed")).statusCode, 400);
    await sleep(100);
    eq(sent.length, 1);
    eq(await statusOf(other), "pending");

    // send failure: response unchanged, failed audit
    failSend = true;
    const failing = await insertOrder({ method: "cod" });
    const { lines, value } = await captureConsole(async () => {
      const r = await patchStatus(token, failing, "confirmed", { confirmation_method: "whatsapp" });
      await waitFor(async () => (await emailAudits()).length === 2);
      return r;
    });
    eq(value.statusCode, 200);
    eq(value.body, { success: true, order_id: failing, status: "confirmed" });
    eq((await emailAudits())[1].action, "customer_email_failed");
    const blob = lines.join("\n");
    ok(blob.includes(`[mail] send failed kind=customer_confirmed order=${failing} code=ESOCKET`));
    ok(!blob.includes("example.test") && !/Order confirmed|Good news/i.test(blob), "logs carry no address/subject/body");
  });

  /* 6 ------------------------------------------------------------ */
  await section("6b. store email audit: failed + skipped throttle + MAIL_FROM", async () => {
    // failed
    failSend = true;
    const failRes = await placeOrder({ customer_email: "buyer.fail@example.test" });
    eq(failRes.statusCode, 200, JSON.stringify(failRes.body));
    ok(await waitFor(async () => (await storeAudits()).length === 1));
    eq((await storeAudits())[0].action, "store_email_failed");
    // REDACT rules unchanged: key name "code" is redacted; detail still carries only that key (no address/subject/body).
    eq(JSON.parse((await storeAudits())[0].detail_json), { code: "[redacted]" });
    ok(!String((await storeAudits())[0].summary + (await storeAudits())[0].detail_json).includes("example.test"));

    // skipped (not configured) + throttle
    failSend = false;
    sent.length = 0;
    await pool.query("DELETE FROM admin_audit_log");
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    __resetStoreEmailSkipThrottleForTests();
    const skip1 = await placeOrder({ customer_email: "buyer.skip1@example.test" });
    eq(skip1.statusCode, 200);
    ok(await waitFor(async () => (await storeAudits()).length === 1));
    eq((await storeAudits())[0].action, "store_email_skipped");
    eq(JSON.parse((await storeAudits())[0].detail_json), { reason: "not_configured" });
    const skip2 = await placeOrder({ customer_email: "buyer.skip2@example.test" });
    eq(skip2.statusCode, 200);
    await sleep(250);
    eq((await storeAudits()).length, 1, "store_email_skipped throttled within 10 minutes");
    eq(sent.length, 0);

    // customer skip when received ON + not configured
    await setFlags({ customer_email_received_enabled: "1" });
    const custSkip = await placeOrder({ customer_email: "buyer.custskip@example.test" });
    eq(custSkip.statusCode, 200);
    ok(await waitFor(async () => (await emailAudits()).length === 1));
    eq((await emailAudits())[0].action, "customer_email_skipped");
    eq(JSON.parse((await emailAudits())[0].detail_json), { kind: "received", reason: "not_configured" });

    // MAIL_FROM valid on store send
    process.env.SMTP_USER = "mock-user";
    process.env.SMTP_PASS = "mock-pass";
    process.env.MAIL_FROM = "override.from@example.test";
    await setFlags({});
    await pool.query("DELETE FROM admin_audit_log");
    sent.length = 0;
    const mailFromRes = await placeOrder({ customer_email: "buyer.mf@example.test" });
    eq(mailFromRes.statusCode, 200);
    ok(await waitFor(async () => sent.length === 1 && (await storeAudits()).length === 1));
    eq(sent[0].from, `"S&Y Orders" <override.from@example.test>`);
    delete process.env.MAIL_FROM;
  });

  await section("6. RBAC: new keys need settings:accounts; admin-accounts-settings is additive", async () => {
    const tokens = {
      writer: await mintToken("writer"),
      manager: await mintToken("manager"),
      super_admin: await mintToken("super_admin"),
    };
    const rows = () => pool.query("SELECT content_key FROM site_content WHERE content_key LIKE 'customer_email_%'").then(([r]) => r);
    const write = (token, body, extra = {}) =>
      admin(siteContentHandler, token, { method: "POST", url: "/api/site-content", body, ...extra });

    const attempts = [
      { key: "customer_email_received_enabled", value: "1" },
      { updates: [{ key: "customer_email_confirmed_enabled", value: "1" }] },
      { updates: [{ key: "hero_title", value: "ok" }, { key: "customer_email_received_enabled", value: "1" }] },
    ];
    for (const body of attempts) {
      eq((await write(null, body)).statusCode, 401, "anonymous");
      for (const role of ["writer", "manager"]) {
        const r = await write(tokens[role], body);
        eq(r.statusCode, 403, `${role} ${JSON.stringify(body).slice(0, 60)}`);
        eq(r.body, { error: "Forbidden" });
      }
    }
    eq((await rows()).length, 0, "nothing written by non-super_admin");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM site_content WHERE content_key = 'hero_title'"), 0, "mixed batch writes nothing");

    for (const value of ["2", "true", "", "yes"]) {
      eq((await write(tokens.super_admin, { key: "customer_email_received_enabled", value })).statusCode, 400, `invalid ${JSON.stringify(value)}`);
    }
    eq((await rows()).length, 0);

    // admin-accounts-settings: additive field, existing fields kept
    const off = await admin(adminAccountsSettingsHandler, tokens.super_admin, { url: "/api/admin-accounts-settings" });
    eq(off.statusCode, 200, JSON.stringify(off.body));
    eq(off.body, {
      success: true,
      settings: { accounts_enabled: false },
      otpProviderConfigured: true,
      customerEmails: { received: false, confirmed: false },
    });

    const on = await write(tokens.super_admin, {
      updates: [
        { key: "customer_email_received_enabled", value: "1" },
        { key: "customer_email_confirmed_enabled", value: "1" },
      ],
    });
    eq(on.statusCode, 200, JSON.stringify(on.body));
    const read = await admin(adminAccountsSettingsHandler, tokens.super_admin, { url: "/api/admin-accounts-settings" });
    eq(read.body.customerEmails, { received: true, confirmed: true }, "cache reset by the write");
    eq(await count(pool, "SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'setting_change' AND entity_type = 'site_content'"), 1, "audited as setting_change");
  });
} catch (e) {
  failure = e;
} finally {
  nodemailer.createTransport = realCreateTransport;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await pool.end().catch(() => {});
}

if (failure) {
  console.error("customer-email-db: FAIL", failure.message);
  process.exit(1);
}
console.log(`customer-email-db: OK ${sections.length} sections, ${total()} assertions`);
for (const s of sections) console.log(`  - ${s}`);
