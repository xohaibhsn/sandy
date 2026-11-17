/**
 * SANDY-BATCH-05 Phase 2 — admin new-order email: every user-supplied value is HTML-escaped and the subject
 * cannot carry CR/LF or control characters (mock transport, nothing is sent).
 *
 * The REAL handler (pages/api/orders.ts) runs against sandy_mig_orders (schema from migrations only).
 * nodemailer.createTransport is replaced by a recorder, so no SMTP connection is ever made.
 *
 * Env: SANDY_TEST_DB_PASSWORD   Run: node tests/orders-email.test.mjs
 */
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
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

await rebuildFromMigrations();
const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const orders = (await importFromRoot("pages/api/orders.ts")).default;
const { CONTACT_EMAIL } = await importFromRoot("lib/site.ts");

const { eq, ok, total } = makeAssertions(assert);
const sections = [];

const realCreateTransport = nodemailer.createTransport;
const savedEnv = { SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS };
const sent = [];
let transportsCreated = 0;

function installMockTransport() {
  nodemailer.createTransport = () => {
    transportsCreated += 1;
    return {
      sendMail: async (mail) => {
        sent.push(mail);
        return { messageId: "mock" };
      },
    };
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function placeOrder(overrides) {
  __rateLimitTestUtils.clearStore();
  await sleep(5);
  return invoke(orders, { url: "/api/orders", body: checkoutBody(overrides) });
}

const SCRIPT = "<script>alert(1)</script>";
const HOSTILE = (label) => `${label} ${SCRIPT} "q" 'a' & <img src=x onerror=alert(2)>`;

let failure = null;
try {
  const hostileProduct = `Case ${SCRIPT} "x" & <b>bold</b>`;
  const hostileCoupon = `W<SCRIPT>1</SCRIPT>&"Q`;
  await pool.query(
    `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
     VALUES (?, 'hostile-case', 999, 'Accessories', '50', 1, 50, 1)`,
    [hostileProduct]
  );
  const product = await one(pool, "SELECT id FROM products WHERE slug = 'hostile-case'");
  await pool.query("INSERT INTO coupons (code, type, value, minimum_order) VALUES (?, 'percentage', 10, 0)", [hostileCoupon]);

  // ------------------------------------------------------------------ no SMTP config => no email at all
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  installMockTransport();
  const quiet = await placeOrder({ items: [{ id: product.id, qty: 1 }] });
  eq(quiet.statusCode, 200, JSON.stringify(quiet.body));
  eq(transportsCreated, 0, "no transport without SMTP credentials");
  eq(sent.length, 0, "no email without SMTP credentials");
  sections.push("sending condition unchanged: no SMTP credentials => no transport, no email");

  // ------------------------------------------------------------------ hostile values in every field
  process.env.SMTP_USER = "mock-user";
  process.env.SMTP_PASS = "mock-pass";

  const fields = {
    customer_name: HOSTILE("Name"),
    customer_email: `x"><script>alert(3)</script>@example.test`,
    customer_phone: `1<b>"&'</b>`, // phone is capped at 50 chars
    delivery_address: HOSTILE("Addr"),
    city: HOSTILE("City"),
    postcode: HOSTILE("Post"),
    notes: `Line1 ${SCRIPT}\nLine2 "q" & 'a'\r\nLine3 <b>x</b>`,
    payment_reference: HOSTILE("Ref"),
  };
  const res = await placeOrder({
    ...fields,
    payment_method: "jazzcash",
    coupon_code: hostileCoupon,
    items: [{ id: product.id, qty: 2 }],
  });
  eq(res.statusCode, 200, JSON.stringify(res.body));
  eq(sent.length, 1, "exactly one admin email");
  const mail = sent[0];
  const html = String(mail.html);

  await (async () => {
    // recipients / sender unchanged
    eq(mail.to, CONTACT_EMAIL, "recipient is still the configured contact email");
    ok(/^"[^"\r\n]+ Orders" <[^<>\r\n]+>$/.test(mail.from), "from header shape unchanged");
    sections.push("recipients and sender unchanged");
  })();

  // No raw hostile markup anywhere in the HTML.
  ok(!/<script/i.test(html), "no raw <script> tag");
  ok(!/<img/i.test(html), "no raw <img> tag");
  ok(!/<SCRIPT/.test(html), "no raw upper-case <SCRIPT> (coupon)");
  ok(!/onerror=alert\(2\)>/.test(html), "no raw tag that closes with onerror");
  ok(!/<b>/i.test(html), "no raw <b> from user fields (the template itself uses none)");
  ok(!/x"><script/i.test(html), "email cannot break out of the cell");
  sections.push("no raw user markup in the email HTML");

  // Each field appears in its escaped form.
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  for (const key of ["customer_name", "customer_email", "customer_phone", "payment_reference"]) {
    ok(html.includes(esc(fields[key])), `${key} present, escaped`);
  }
  ok(html.includes(esc(fields.delivery_address)), "address present, escaped");
  ok(html.includes(esc(fields.city)), "city present, escaped");
  ok(html.includes(esc(fields.postcode)), "postcode present, escaped");
  ok(html.includes(esc(hostileProduct)), "item name present, escaped");
  ok(html.includes(esc(hostileCoupon)), "coupon code present, escaped");
  ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "script text is visible but inert");
  ok(html.includes("&quot;q&quot;") && html.includes("&#39;a&#39;") && html.includes(" &amp; "), "quotes and ampersands escaped");
  // Address cell keeps its ", " separators between the three parts.
  ok(html.includes(`${esc(fields.delivery_address)}, ${esc(fields.city)}, ${esc(fields.postcode)}`), "address joined with commas");
  sections.push("every user-supplied field is escaped (name, email, phone, address, city, postcode, item, coupon, reference)");

  // Notes: escaped first, then newlines become <br>.
  const notesCell = html.match(/Notes<\/td><td[^>]*>([\s\S]*?)<\/td>/);
  ok(notesCell, "notes row present");
  eq(
    notesCell[1],
    "Line1 &lt;script&gt;alert(1)&lt;/script&gt;<br>Line2 &quot;q&quot; &amp; &#39;a&#39;<br>Line3 &lt;b&gt;x&lt;/b&gt;",
    "notes: escaped, then line breaks -> <br>"
  );
  ok(!/[\r\n]/.test(notesCell[1]), "no raw line breaks left in the notes cell");
  sections.push("notes escaped, line breaks rendered as <br>");

  // Our own template still renders (layout not broken by escaping).
  ok(html.includes("New Order Received") && html.includes("Order Items") && html.includes("Grand Total"), "template intact");
  ok(html.includes("JazzCash"), "payment label rendered");
  sections.push("template structure intact");

  // ------------------------------------------------------------------ subject
  const subject = String(mail.subject);
  ok(!/[\r\n\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(subject), "subject has no CR/LF/control characters");
  ok(subject.startsWith("🛍️ New Order ORD-"), "subject prefix unchanged");
  ok(subject.includes(" — "), "subject separator unchanged");
  sections.push("subject is a single clean line");

  // Header-injection attempt + overlong name: CR/LF stripped, name capped at 80 chars.
  const inject = `Mallory\r\nBcc: attacker@example.test\nSubject: pwned\u0000\u0007${"x".repeat(200)}`;
  sent.length = 0;
  const res2 = await placeOrder({ customer_name: inject, items: [{ id: product.id, qty: 1 }] });
  eq(res2.statusCode, 200, JSON.stringify(res2.body));
  eq(sent.length, 1);
  const subject2 = String(sent[0].subject);
  ok(!/[\r\n\u0000-\u001F\u007F-\u009F]/.test(subject2), "injection: no CR/LF/control chars");
  const namePart = subject2.split(" — ").slice(1).join(" — ");
  ok(namePart.length <= 80, `customer-name part capped at 80 (got ${namePart.length})`);
  ok(namePart.startsWith("Mallory"), "name kept");
  ok(!/\n/.test(subject2) && !/\r/.test(subject2));
  // Stored order still has the original (unmodified) name: only the email subject is sanitised.
  const stored = await one(pool, "SELECT customer_name AS n FROM orders WHERE order_id = ?", [res2.body.order_id]);
  eq(stored.n, inject.trim(), "stored customer name unchanged");
  sections.push("subject: CR/LF/control chars stripped, name part capped at 80 chars, stored data untouched");

  // Plain, well-behaved order still reads naturally.
  sent.length = 0;
  const res3 = await placeOrder({ customer_name: "Ayesha Khan", notes: "", payment_reference: "", items: [{ id: product.id, qty: 1 }] });
  eq(res3.statusCode, 200, JSON.stringify(res3.body));
  eq(sent.length, 1);
  ok(String(sent[0].subject).endsWith(" — Ayesha Khan"), "normal subject unchanged");
  ok(!/Notes<\/td>/.test(String(sent[0].html)), "empty notes row omitted (unchanged)");
  ok(!/Reference<\/td>/.test(String(sent[0].html)), "empty reference row omitted (unchanged)");
  sections.push("ordinary orders render unchanged");
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
  console.error("orders-email: FAIL", failure.message);
  process.exit(1);
}
console.log(`orders-email: OK ${sections.length} sections, ${total()} assertions`);
for (const s of sections) console.log(`  - ${s}`);
