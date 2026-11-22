/**
 * Customer order emails (SANDY-BATCH-48 CUSTOMER-EMAIL-01) — unit test, no network, no real database.
 *
 * lib/db reads globalThis._mysqlPool lazily, so an in-memory fake pool is enough to run the REAL
 * pages/api/admin-orders.ts, site-content.ts and admin-accounts-settings.ts handlers. nodemailer.createTransport
 * is replaced by a recorder (or the real jsonTransport for the transport-selection cases): nothing is sent.
 *
 * Run: node --test tests/customer-emails.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import { describe, it, beforeEach, afterEach } from "node:test";
import nodemailer from "nodemailer";
import { ensureTestMasterLoginEnv, installTsResolveHook, invoke, root } from "./orders-test-support.mjs";

installTsResolveHook();
ensureTestMasterLoginEnv();

/* ------------------------------------------------------------------ in-memory fake pool */

const tokens: Record<string, string> = {
  writer: "a".repeat(64),
  manager: "b".repeat(64),
  super_admin: "c".repeat(64),
};
const roleByHash = new Map(
  Object.entries(tokens).map(([role, t]) => [crypto.createHash("sha256").update(t).digest("hex"), role])
);

type AuditRow = { actor_type: unknown; action: string; entity_id: unknown; summary: string; detail: string | null };

const CUSTOMER_EMAIL = "buyer.person@example.test";
const HOSTILE_NAME = `Zed <script>alert(1)</script> "Q"`;
const HOSTILE_ITEM = `Case <b>bold</b> & "x"`;

const db = {
  site: new Map<string, string>(),
  audits: [] as AuditRow[],
  queries: [] as string[],
  order: null as null | { status: string; payment_method: string },
  orderEmail: CUSTOMER_EMAIL,
  orderName: HOSTILE_NAME,
};

function resetDb() {
  db.site.clear();
  db.audits.length = 0;
  db.queries.length = 0;
  db.order = { status: "pending", payment_method: "bank" };
  db.orderEmail = CUSTOMER_EMAIL;
  db.orderName = HOSTILE_NAME;
}

async function fakeQuery(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
  const text = String(sql);
  db.queries.push(text);
  if (/FROM admin_sessions/i.test(text) && /SELECT/i.test(text)) {
    const role = roleByHash.get(String(params[0]));
    if (!role) return [[], []];
    return [[{ id: 1, staff_id: null, is_master: 1, role, name: `fake-${role}` }], []];
  }
  if (/INFORMATION_SCHEMA\.TABLES/i.test(text) && /admin_audit_log/.test(text)) return [[{ ok: 1 }], []];
  if (/INSERT INTO admin_audit_log/i.test(text)) {
    db.audits.push({
      actor_type: params[0],
      action: String(params[4]),
      entity_id: params[6],
      summary: String(params[7]),
      detail: (params[8] as string | null) ?? null,
    });
    return [{ affectedRows: 1 }, []];
  }
  if (/INSERT INTO site_content/i.test(text)) {
    db.site.set(String(params[0]), String(params[1]));
    return [{ affectedRows: 1 }, []];
  }
  if (/FROM site_content/i.test(text) && /content_key IN/i.test(text)) {
    const keys = (Array.isArray(params[0]) ? (params[0] as unknown[]) : params).map(String);
    const rows = keys.filter((k) => db.site.has(k)).map((k) => ({ content_key: k, content_value: db.site.get(k) }));
    return [rows, []];
  }
  if (/FROM order_items/i.test(text)) {
    return [
      [
        { product_name: HOSTILE_ITEM, price: 1000, quantity: 2 },
        { product_name: "Cable", price: 500, quantity: 1 },
      ],
      [],
    ];
  }
  if (/FROM order_tax_snapshots/i.test(text)) return [[{ tax_label: "GST 17%" }], []];
  if (/UPDATE orders\s+SET status = 'confirmed'/i.test(text)) {
    const changed = db.order && db.order.status !== "confirmed" ? 1 : 0;
    if (db.order) db.order.status = "confirmed";
    return [{ affectedRows: 1, changedRows: changed }, []];
  }
  if (/UPDATE orders SET status = \?/i.test(text)) {
    const next = String(params[0]);
    const changed = db.order && db.order.status !== next ? 1 : 0;
    if (db.order) db.order.status = next;
    return [{ affectedRows: db.order ? 1 : 0, changedRows: changed }, []];
  }
  if (/FROM orders WHERE order_id = \?/i.test(text) && /customer_email/.test(text)) {
    if (!db.order) return [[], []];
    return [
      [
        {
          order_id: String(params[0]),
          customer_name: db.orderName,
          customer_email: db.orderEmail,
          payment_method: db.order.payment_method,
          total: 2700,
          coupon_code: "SAVE<5>",
          discount_amount: 100,
          vat_amount: 400,
          shipping_amount: 200,
          shipping_zone: "Punjab",
        },
      ],
      [],
    ];
  }
  if (/FROM orders WHERE order_id = \?/i.test(text)) {
    if (!db.order) return [[], []];
    return [
      [
        {
          order_id: String(params[0]),
          status: db.order.status,
          coupon_code: null,
          payment_method: db.order.payment_method,
          confirmed_at: null,
        },
      ],
      [],
    ];
  }
  return [[], []];
}

const fakePool = {
  query: fakeQuery,
  async getConnection() {
    return {
      query: fakeQuery,
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
    };
  },
};
(globalThis as unknown as { _mysqlPool: unknown })._mysqlPool = fakePool;

/* ------------------------------------------------------------------ modules under test */

const settingsMod = await import("../lib/customerEmailSettings.ts");
const {
  CUSTOMER_EMAIL_SETTINGS_KEYS,
  isCustomerEmailSettingsContentKey,
  loadCustomerEmailSettings,
  parseCustomerEmailSettingsMap,
  resetCustomerEmailSettingsCache,
  validateCustomerEmailSetting,
} = settingsMod;
const { buildOrderConfirmedEmail, buildOrderReceivedEmail } = await import("../lib/customerEmails.ts");
const { sanitizeSubjectPart, isValidCustomerEmail } = await import("../lib/emailText.ts");
const { createOrderTransport, sendMailSafe } = await import("../lib/mailer.ts");
const { sendCustomerOrderEmail } = await import("../lib/customerEmailDispatch.ts");
const { buildStoreNewOrderEmail } = await import("../lib/storeOrderEmail.ts");
const { resetOrderProtectionSettingsCache } = await import("../lib/orderProtectionSettings.ts");
const { resetAuditSchemaProbeForTests } = await import("../lib/auditLog.ts");
const adminOrders = (await import("../pages/api/admin-orders.ts")).default;
const siteContent = (await import("../pages/api/site-content.ts")).default;
const adminAccountsSettings = (await import("../pages/api/admin-accounts-settings.ts")).default;

/* ------------------------------------------------------------------ helpers */

type Sent = Record<string, unknown>;
const realCreateTransport = nodemailer.createTransport;
const sent: Sent[] = [];
let failSend: null | { code?: string } = null;

function installMockTransport() {
  (nodemailer as unknown as { createTransport: unknown }).createTransport = () => ({
    sendMail: async (mail: Sent) => {
      if (failSend) {
        // The error text deliberately carries the recipient, subject and body: none of it may be logged.
        const err = new Error(`failed for ${String(mail.to)} subject=${String(mail.subject)} body=${String(mail.html)}`);
        (err as { code?: string }).code = failSend.code;
        throw err;
      }
      sent.push(mail);
      return { messageId: "mock" };
    },
  });
}

const mutableEnv = process.env as Record<string, string | undefined>;
const setNodeEnv = (v: string) => {
  mutableEnv.NODE_ENV = v;
};
const saved: Record<string, string | undefined> = {};
for (const k of ["SMTP_USER", "SMTP_PASS", "SANDY_MAIL_JSON_TRANSPORT", "NODE_ENV"]) saved[k] = process.env[k];

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function setFlags(map: Record<string, string>) {
  db.site.clear();
  for (const [k, v] of Object.entries(map)) db.site.set(k, v);
  resetCustomerEmailSettingsCache();
  resetOrderProtectionSettingsCache();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

function emailAudits() {
  return db.audits.filter((a) => a.action.startsWith("customer_email_"));
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = [];
  const savedConsole: Record<string, (...a: unknown[]) => void> = {};
  for (const m of ["error", "warn", "log", "info", "debug"] as const) {
    savedConsole[m] = console[m];
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 6 }))).join(" "));
    };
  }
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    for (const m of Object.keys(savedConsole) as Array<"error" | "warn" | "log" | "info" | "debug">) {
      console[m] = savedConsole[m] as never;
    }
  }
}

function patch(orderId: string, status: string, extra: Record<string, unknown> = {}) {
  return invoke(adminOrders, {
    method: "PATCH",
    url: "/api/admin-orders",
    body: { order_id: orderId, status, ...extra },
    cookies: { sAdminSession: tokens.super_admin },
    headers: { origin: "http://orders.test" },
  });
}

const sampleOrder = {
  orderId: "SY-2026-0001",
  customerName: HOSTILE_NAME,
  customerEmail: CUSTOMER_EMAIL,
  items: [
    { name: HOSTILE_ITEM, qty: 2, lineTotal: 2000 },
    { name: "Cable", qty: 1, lineTotal: 500 },
  ],
  shipping: 200,
  shippingZoneName: "Punjab <Zone>",
  shippingOn: true,
  taxLabel: "GST 17%",
  taxAmount: 400,
  discountAmount: 100,
  discountLabel: "SAVE<5>",
  grandTotal: 3000,
  paymentMethod: "cod",
  contactEmail: "help@example.test",
};

beforeEach(() => {
  resetDb();
  sent.length = 0;
  failSend = null;
  restoreEnv();
  process.env.SMTP_USER = "smtp-user";
  process.env.SMTP_PASS = "smtp-pass";
  delete process.env.SANDY_MAIL_JSON_TRANSPORT;
  setNodeEnv("test");
  installMockTransport();
  setFlags({});
  resetAuditSchemaProbeForTests();
});

afterEach(() => {
  (nodemailer as unknown as { createTransport: unknown }).createTransport = realCreateTransport;
  restoreEnv();
});

/* ------------------------------------------------------------------ settings */

describe("customerEmailSettings", () => {
  it("keys, defaults OFF, strict 0/1 parse", () => {
    assert.deepEqual([...CUSTOMER_EMAIL_SETTINGS_KEYS], [
      "customer_email_received_enabled",
      "customer_email_confirmed_enabled",
    ]);
    assert.deepEqual(parseCustomerEmailSettingsMap({}), {
      customer_email_received_enabled: false,
      customer_email_confirmed_enabled: false,
    });
    assert.deepEqual(
      parseCustomerEmailSettingsMap({ customer_email_received_enabled: "1", customer_email_confirmed_enabled: "0" }),
      { customer_email_received_enabled: true, customer_email_confirmed_enabled: false }
    );
    for (const bad of ["true", "yes", "2", "", " ", "on", null, undefined]) {
      assert.deepEqual(
        parseCustomerEmailSettingsMap({ customer_email_received_enabled: bad, customer_email_confirmed_enabled: bad }),
        { customer_email_received_enabled: false, customer_email_confirmed_enabled: false },
        `invalid ${String(bad)} => OFF`
      );
    }
  });

  it("validate accepts only 0/1 for known keys; key guard", () => {
    for (const key of CUSTOMER_EMAIL_SETTINGS_KEYS) {
      assert.deepEqual(validateCustomerEmailSetting(key, "1"), { ok: true, value: "1" });
      assert.deepEqual(validateCustomerEmailSetting(key, " 0 "), { ok: true, value: "0" });
      for (const bad of ["2", "true", "", null, undefined, "yes"]) {
        assert.equal(validateCustomerEmailSetting(key, bad).ok, false);
      }
    }
    assert.equal(validateCustomerEmailSetting("accounts_enabled", "1").ok, false);
    assert.equal(isCustomerEmailSettingsContentKey("customer_email_received_enabled"), true);
    assert.equal(isCustomerEmailSettingsContentKey("accounts_enabled"), false);
    assert.equal(isCustomerEmailSettingsContentKey(undefined), false);
  });

  it("loads {received, confirmed}, caches 10s, resets on demand", async () => {
    assert.deepEqual(await loadCustomerEmailSettings(), { received: false, confirmed: false });
    db.site.set("customer_email_received_enabled", "1");
    assert.deepEqual(await loadCustomerEmailSettings(), { received: false, confirmed: false }, "served from cache");
    resetCustomerEmailSettingsCache();
    assert.deepEqual(await loadCustomerEmailSettings(), { received: true, confirmed: false });
  });
});

/* ------------------------------------------------------------------ builders */

describe("customer email builders", () => {
  it("received: escaped content, sanitized single-line subject, no phone/address, text alt, reply-to", () => {
    const msg = buildOrderReceivedEmail({
      ...sampleOrder,
      orderId: "SY-1\r\nBcc: evil@example.test",
    });
    assert.equal(msg.subject, "Order received — SY-1 Bcc: evil@example.test");
    assert.ok(!/[\r\n]/.test(msg.subject), "subject has no CR/LF");
    assert.equal(msg.to, CUSTOMER_EMAIL);
    assert.equal(msg.from, '"S&Y Orders" <noreply@sandy.com.pk>');
    assert.equal(msg.replyTo, "help@example.test");
    assert.ok(!msg.html.includes("<script>"), "script tag escaped");
    assert.ok(msg.html.includes("Zed"), "first name used");
    assert.ok(!msg.html.includes("alert(1)"), "only the first name token is used");
    assert.ok(msg.html.includes("Case &lt;b&gt;bold&lt;/b&gt; &amp; &quot;x&quot;"), "item name escaped");
    assert.ok(msg.html.includes("Punjab &lt;Zone&gt;"), "zone escaped");
    assert.ok(msg.html.includes("SAVE&lt;5&gt;"), "coupon escaped");
    assert.ok(msg.html.includes("https://sandy.com.pk/order-tracking"), "tracking link");
    assert.ok(msg.html.includes("automated message from S&amp;Y"), "footer");
    assert.ok(msg.text.includes("Hi Zed,"));
    assert.ok(msg.text.includes("Track your order: https://sandy.com.pk/order-tracking"));
    assert.ok(msg.text.includes("Payment: Cash on Delivery"));
    assert.ok(!/<[a-z]/i.test(msg.text.replace(/<b>bold<\/b>|<Zone>|<5>/g, "")), "text alt has no markup from the template");
    assert.ok(!/03\d{9}|Street|address/i.test(msg.html + msg.text), "no phone / address");
  });

  it("confirmed uses its own subject; optional lines only when present", () => {
    const bare = buildOrderConfirmedEmail({
      orderId: "SY-9",
      customerName: "",
      customerEmail: CUSTOMER_EMAIL,
      items: [{ name: "Thing", qty: 1, lineTotal: 10 }],
      grandTotal: 10,
      paymentMethod: "bank",
    });
    assert.equal(bare.subject, "Order confirmed — SY-9");
    assert.equal(bare.replyTo, undefined);
    assert.ok(bare.text.startsWith("Hi there,"));
    assert.ok(!/Shipping|Discount|Tax/.test(bare.text), "no shipping/tax/discount lines");
    assert.ok(bare.text.includes("Payment: Bank Transfer"));
  });

  it("sanitizeSubjectPart / isValidCustomerEmail", () => {
    assert.equal(sanitizeSubjectPart("a\r\nb\tc", 64), "a b c");
    assert.equal(isValidCustomerEmail("a@b.co"), true);
    for (const bad of ["", "no-at", "a@b", "a b@c.de", "a@b.c\r\nBcc: x@y.z", "@b.cd"]) {
      assert.equal(isValidCustomerEmail(bad), false, bad);
    }
  });
});

/* ------------------------------------------------------------------ mailer */

describe("mailer", () => {
  it("test-only JSON transport: used when flag=1 and not production; ignored in production", () => {
    (nodemailer as unknown as { createTransport: unknown }).createTransport = realCreateTransport;
    process.env.SANDY_MAIL_JSON_TRANSPORT = "1";
    setNodeEnv("test");
    const name = (t: unknown) => (t as { transporter?: { name?: string } }).transporter?.name;
    assert.equal(name(createOrderTransport()), "JSONTransport");
    setNodeEnv("production");
    assert.notEqual(name(createOrderTransport()), "JSONTransport", "flag ignored in production");
    setNodeEnv("test");
    delete process.env.SANDY_MAIL_JSON_TRANSPORT;
    assert.notEqual(name(createOrderTransport()), "JSONTransport");
  });

  it("sendMailSafe never throws and logs only kind / order / code", async () => {
    failSend = { code: "ESOCKET" };
    const { lines, value } = await captureConsole(() =>
      sendMailSafe(
        { from: "f@example.test", to: "secret.person@example.test", subject: "Secret subject", html: "<p>Secret body</p>" },
        { kind: "store_new_order", orderId: "SY-1" }
      )
    );
    assert.deepEqual(value, { ok: false, code: "ESOCKET" });
    assert.deepEqual(lines, ["[mail] send failed kind=store_new_order order=SY-1 code=ESOCKET"]);

    failSend = { code: undefined };
    const unknown = await captureConsole(() =>
      sendMailSafe({ from: "f@example.test", to: "x@example.test", subject: "s", html: "h" }, { kind: "k", orderId: "o" })
    );
    assert.deepEqual(unknown.value, { ok: false, code: "unknown" });
    assert.deepEqual(unknown.lines, ["[mail] send failed kind=k order=o code=unknown"]);

    failSend = null;
    assert.deepEqual(
      await sendMailSafe({ from: "f@example.test", to: "x@example.test", subject: "s", html: "h" }, { kind: "k", orderId: "o" }),
      { ok: true }
    );
    assert.equal(sent.length, 1);
  });
});

/* ------------------------------------------------------------------ store email golden */

describe("store new-order email is unchanged", () => {
  it("matches the golden fixture captured from the pre-refactor inline template (byte-identical)", () => {
    const input = JSON.parse(readFileSync(path.join(root, "tests/fixtures/store-new-order-email.input.json"), "utf8"));
    const golden = JSON.parse(readFileSync(path.join(root, "tests/fixtures/store-new-order-email.golden.json"), "utf8"));
    const f = (value: string) => ({ value });
    const out = buildStoreNewOrderEmail({
      ...input,
      customer_name: f(input.customer_name),
      customer_email: f(input.customer_email),
      customer_phone: f(input.customer_phone),
      delivery_address: f(input.delivery_address),
      city: f(input.city),
      postcode: f(input.postcode),
      notes: f(input.notes),
      payment_reference: f(input.payment_reference),
    });
    assert.deepEqual(Object.keys(out), ["from", "to", "subject", "html"]);
    assert.equal(out.from, golden.from);
    assert.equal(out.to, golden.to);
    assert.equal(out.subject, golden.subject);
    assert.equal(out.html, golden.html);
    assert.equal(JSON.stringify(out), JSON.stringify(golden));
  });
});

/* ------------------------------------------------------------------ dispatch */

describe("sendCustomerOrderEmail", () => {
  it("flags OFF -> no customer send, no audit", async () => {
    await sendCustomerOrderEmail({ kind: "received", order: sampleOrder });
    await sendCustomerOrderEmail({ kind: "confirmed", order: sampleOrder });
    assert.equal(sent.length, 0);
    assert.equal(emailAudits().length, 0);
  });

  it("received ON -> exactly one send, escaped content, sanitized subject, audit {kind:received}", async () => {
    setFlags({ customer_email_received_enabled: "1" });
    await sendCustomerOrderEmail({ kind: "received", order: { ...sampleOrder, orderId: "SY-7\r\nX: y" } });
    await sendCustomerOrderEmail({ kind: "confirmed", order: sampleOrder });
    assert.equal(sent.length, 1, "confirmed flag is still off");
    const mail = sent[0];
    assert.equal(mail.to, CUSTOMER_EMAIL);
    assert.equal(mail.subject, "Order received — SY-7 X: y");
    assert.ok(!String(mail.html).includes("<script>"));
    assert.equal(emailAudits().length, 1);
    const audit = emailAudits()[0];
    assert.equal(audit.action, "customer_email_sent");
    assert.equal(audit.actor_type, "system");
    assert.deepEqual(JSON.parse(String(audit.detail)), { kind: "received" });
    assert.ok(!String(audit.summary + audit.detail).includes("example.test"), "no address in audit");
  });

  it("invalid customer address -> no send", async () => {
    setFlags({ customer_email_received_enabled: "1" });
    await sendCustomerOrderEmail({ kind: "received", order: { ...sampleOrder, customerEmail: "not-an-email" } });
    await sendCustomerOrderEmail({ kind: "received", order: { ...sampleOrder, customerEmail: "" } });
    assert.equal(sent.length, 0);
  });

  it("no SMTP configuration -> no send (same gate as the store email)", async () => {
    setFlags({ customer_email_received_enabled: "1" });
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    await sendCustomerOrderEmail({ kind: "received", order: sampleOrder });
    assert.equal(sent.length, 0);
  });

  it("send failure -> customer_email_failed audit, nothing thrown, logs carry no address/subject/body", async () => {
    setFlags({ customer_email_received_enabled: "1" });
    failSend = { code: "EAUTH" };
    const { lines } = await captureConsole(() => sendCustomerOrderEmail({ kind: "received", order: sampleOrder }));
    assert.equal(emailAudits().length, 1);
    assert.equal(emailAudits()[0].action, "customer_email_failed");
    assert.deepEqual(JSON.parse(String(emailAudits()[0].detail)), { kind: "received" });
    assert.deepEqual(lines, ["[mail] send failed kind=customer_received order=SY-2026-0001 code=EAUTH"]);
    const blob = lines.join("\n");
    assert.ok(!blob.includes("example.test"), "no recipient");
    assert.ok(!/Order received|Hi Zed|Thank you/i.test(blob), "no subject / body");
  });
});

/* ------------------------------------------------------------------ admin-orders wiring */

describe("admin-orders: confirmed email only on a real transition", () => {
  it("flags OFF -> confirm sends nothing and the response is unchanged", async () => {
    const r = await patch("SY-100", "confirmed");
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { success: true, order_id: "SY-100", status: "confirmed" });
    await sleep(60);
    assert.equal(sent.length, 0);
    assert.equal(emailAudits().length, 0);
  });

  it("confirmed ON, generic path: pending -> confirmed sends once; confirming again sends nothing", async () => {
    setFlags({ customer_email_confirmed_enabled: "1" });
    const first = await patch("SY-101", "confirmed");
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body, { success: true, order_id: "SY-101", status: "confirmed" });
    assert.ok(await waitFor(() => sent.length === 1 && emailAudits().length === 1));
    assert.equal(sent[0].to, CUSTOMER_EMAIL);
    assert.equal(sent[0].subject, "Order confirmed — SY-101");
    assert.ok(String(sent[0].html).includes("Case &lt;b&gt;bold&lt;/b&gt; &amp; &quot;x&quot;"), "server-side snapshot items, escaped");
    assert.ok(String(sent[0].html).includes("Cash on Delivery") === false, "payment label from the stored order (bank)");
    assert.ok(String(sent[0].html).includes("Bank Transfer"));
    assert.equal(emailAudits()[0].action, "customer_email_sent");
    assert.deepEqual(JSON.parse(String(emailAudits()[0].detail)), { kind: "confirmed" });

    const second = await patch("SY-101", "confirmed");
    assert.equal(second.statusCode, 200);
    await sleep(80);
    assert.equal(sent.length, 1, "second confirm does not resend");
    assert.equal(emailAudits().length, 1);
  });

  it("only confirmed triggers: other status changes send nothing", async () => {
    setFlags({ customer_email_confirmed_enabled: "1" });
    const r = await patch("SY-102", "dispatched");
    assert.equal(r.statusCode, 200);
    await sleep(60);
    assert.equal(sent.length, 0);
  });

  it("confirmed ON, COD protection path: real transition sends once; already confirmed does not", async () => {
    setFlags({ customer_email_confirmed_enabled: "1", cod_protection_enabled: "1" });
    db.order = { status: "pending", payment_method: "cod" };
    const first = await patch("SY-103", "confirmed", { confirmation_method: "call" });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true, order_id: "SY-103", status: "confirmed" });
    assert.ok(await waitFor(() => sent.length === 1 && emailAudits().length === 1));
    assert.equal(sent[0].subject, "Order confirmed — SY-103");

    const second = await patch("SY-103", "confirmed", { confirmation_method: "call" });
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    await sleep(80);
    assert.equal(sent.length, 1, "COD re-confirm does not resend");
  });

  it("send failure -> response unchanged + customer_email_failed audit; logs have no address/subject/body", async () => {
    setFlags({ customer_email_confirmed_enabled: "1" });
    failSend = { code: "ETIMEDOUT" };
    const { lines, value } = await captureConsole(async () => {
      const r = await patch("SY-104", "confirmed");
      await waitFor(() => emailAudits().length === 1);
      return r;
    });
    assert.equal(value.statusCode, 200);
    assert.deepEqual(value.body, { success: true, order_id: "SY-104", status: "confirmed" });
    assert.equal(emailAudits()[0].action, "customer_email_failed");
    assert.deepEqual(JSON.parse(String(emailAudits()[0].detail)), { kind: "confirmed" });
    const blob = lines.join("\n");
    assert.ok(blob.includes("[mail] send failed kind=customer_confirmed order=SY-104 code=ETIMEDOUT"));
    assert.ok(!blob.includes("example.test"), "no recipient in logs");
    assert.ok(!/Order confirmed|Hi Zed|Good news/i.test(blob), "no subject / body in logs");
  });

  it("order without a valid email -> no send", async () => {
    setFlags({ customer_email_confirmed_enabled: "1" });
    db.orderEmail = "";
    const r = await patch("SY-105", "confirmed");
    assert.equal(r.statusCode, 200);
    await sleep(60);
    assert.equal(sent.length, 0);
  });
});

/* ------------------------------------------------------------------ site-content + admin endpoint */

describe("RBAC and admin endpoint", () => {
  const post = (role: string | null, body: unknown) =>
    invoke(siteContent, {
      method: "POST",
      url: "/api/site-content",
      body,
      cookies: role ? { sAdminSession: tokens[role] } : {},
      headers: { origin: "http://orders.test" },
    });

  it("new keys need settings:accounts (403 for non-super_admin, nothing written)", async () => {
    const bodies = [
      { key: "customer_email_received_enabled", value: "1" },
      { updates: [{ key: "customer_email_confirmed_enabled", value: "1" }] },
      { updates: [{ key: "hero_title", value: "ok" }, { key: "customer_email_received_enabled", value: "1" }] },
    ];
    for (const body of bodies) {
      assert.equal((await post(null, body)).statusCode, 401);
      for (const role of ["writer", "manager"]) {
        const r = await post(role, body);
        assert.equal(r.statusCode, 403, `${role} ${JSON.stringify(body)}`);
        assert.deepEqual(r.body, { error: "Forbidden" });
      }
    }
    assert.equal(db.site.size, 0, "nothing written by forbidden callers");
  });

  it("super_admin: validates 0/1, writes both keys, resets cache, audits as setting_change", async () => {
    for (const value of ["2", "true", ""]) {
      assert.equal((await post("super_admin", { key: "customer_email_received_enabled", value })).statusCode, 400);
    }
    assert.equal(db.site.size, 0);
    assert.deepEqual(await loadCustomerEmailSettings(), { received: false, confirmed: false });
    const r = await post("super_admin", {
      updates: [
        { key: "customer_email_received_enabled", value: "1" },
        { key: "customer_email_confirmed_enabled", value: "0" },
      ],
    });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(db.site.get("customer_email_received_enabled"), "1");
    assert.equal(db.site.get("customer_email_confirmed_enabled"), "0");
    assert.deepEqual(await loadCustomerEmailSettings(), { received: true, confirmed: false }, "cache reset by the write");
    assert.ok(db.audits.some((a) => a.action === "setting_change"), "audited as a setting change");
  });

  it("admin-accounts-settings: additive customerEmails field, existing fields kept", async () => {
    const get = (role: string | null) =>
      invoke(adminAccountsSettings, {
        method: "GET",
        url: "/api/admin-accounts-settings",
        cookies: role ? { sAdminSession: tokens[role] } : {},
        headers: { origin: "http://orders.test" },
      });
    assert.equal((await get(null)).statusCode, 401);
    assert.equal((await get("manager")).statusCode, 403);
    const off = await get("super_admin");
    assert.equal(off.statusCode, 200);
    const body = off.body as unknown as Record<string, unknown>;
    assert.deepEqual(body.settings, { accounts_enabled: false });
    assert.equal(typeof body.otpProviderConfigured, "boolean");
    assert.equal(body.success, true);
    assert.deepEqual(body.customerEmails, { received: false, confirmed: false });

    setFlags({ customer_email_received_enabled: "1", customer_email_confirmed_enabled: "1" });
    const on = await get("super_admin");
    assert.deepEqual((on.body as unknown as Record<string, unknown>).customerEmails, { received: true, confirmed: true });
  });
});
