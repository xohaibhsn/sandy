// Run with: npm test   (node --test, Node >= 22.18 / 24 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGAL_DEFAULT_HTML,
  isEffectivelyEmptyHtml,
  renderLegalBody,
} from "../lib/legalContent.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contact = { email: "store@example.com", phone: "+92000000000" };

test("isEffectivelyEmptyHtml: empty / whitespace / empty p variants", () => {
  assert.equal(isEffectivelyEmptyHtml(""), true);
  assert.equal(isEffectivelyEmptyHtml("   \n\t  "), true);
  assert.equal(isEffectivelyEmptyHtml("<p></p>"), true);
  assert.equal(isEffectivelyEmptyHtml("<p>&nbsp;</p>"), true);
  assert.equal(isEffectivelyEmptyHtml("<p>Hello</p>"), false);
});

test("renderLegalBody: empty raw uses default source", () => {
  for (const raw of ["", "  ", "<p></p>", "<p>&nbsp;</p>"]) {
    const r = renderLegalBody(raw, LEGAL_DEFAULT_HTML.terms, contact);
    assert.equal(r.source, "default");
  }
});

test("renderLegalBody: real CMS HTML uses cms source", () => {
  const r = renderLegalBody("<h2>1. Custom</h2><p>Body</p>", LEGAL_DEFAULT_HTML.terms, contact);
  assert.equal(r.source, "cms");
  assert.match(r.html, /Custom/);
});

test("tokens replaced and contact script escaped", () => {
  const raw =
    "<h2>1. Contact</h2><p>{{contact_email}} / {{contact_phone}}</p>";
  const r = renderLegalBody(
    raw,
    LEGAL_DEFAULT_HTML.terms,
    { email: '<script>alert(1)</script>', phone: "x" },
  );
  assert.equal(r.source, "cms");
  assert.ok(!r.html.includes("<script>"));
  assert.ok(r.html.includes("&lt;script&gt;") || r.html.includes("&lt;script"));
});

test("CMS script/onerror stripped; h2 id/class not kept", () => {
  const raw =
    '<h2 id="evil" class="x">1. Safe</h2><p><img src=x onerror="alert(1)"><script>bad()</script>ok</p>';
  const r = renderLegalBody(raw, LEGAL_DEFAULT_HTML.terms, contact);
  assert.ok(!/<script/i.test(r.html));
  assert.ok(!/onerror=/i.test(r.html));
  assert.ok(!/<h2[^>]*\bid=/i.test(r.html));
  assert.ok(!/<h2[^>]*\bclass=/i.test(r.html));
  assert.match(r.html, /id="safe"/);
});

test("toc ids appear once as wrapper ids; duplicates get -2", () => {
  const raw = "<h2>1. Same</h2><p>a</p><h2>2. Same</h2><p>b</p>";
  const r = renderLegalBody(raw, LEGAL_DEFAULT_HTML.terms, contact);
  assert.equal(r.toc.length, 2);
  assert.equal(r.toc[0].id, "same");
  assert.equal(r.toc[1].id, "same-2");
  for (const item of r.toc) {
    const re = new RegExp(`id="${item.id}"`, "g");
    const matches = r.html.match(re) || [];
    assert.equal(matches.length, 1, item.id);
  }
});

test("defaults: no legacy strings; required markers; heading counts", () => {
  const forbidden = /England|Wales|subscription|free trial|VPN|streaming|IPTV|2–5 working days/i;
  for (const key of ["terms", "privacy", "refund"] as const) {
    assert.equal(forbidden.test(LEGAL_DEFAULT_HTML[key]), false, key);
  }
  assert.match(LEGAL_DEFAULT_HTML.terms, /laws of Pakistan/);
  assert.match(LEGAL_DEFAULT_HTML.terms, /courts at Lahore/);
  assert.match(LEGAL_DEFAULT_HTML.refund, /14 days/);
  assert.match(LEGAL_DEFAULT_HTML.refund, /48 hours/);
  assert.match(LEGAL_DEFAULT_HTML.refund, /5–7 working days/);
  assert.match(LEGAL_DEFAULT_HTML.privacy, /30 days/);
  assert.match(LEGAL_DEFAULT_HTML.privacy, /365 days/);

  const countH2 = (html: string) => (html.match(/<h2>/g) || []).length;
  assert.equal(countH2(LEGAL_DEFAULT_HTML.terms), 13);
  assert.equal(countH2(LEGAL_DEFAULT_HTML.privacy), 11);
  assert.equal(countH2(LEGAL_DEFAULT_HTML.refund), 9);

  const termsOrder = [
    "1. Agreement to Terms",
    "2. About Us",
    "3. Products & Prices",
    "4. Orders & Confirmation",
    "5. Payment",
    "6. Shipping & Delivery",
    "7. Cancellations",
    "8. Returns & Refunds",
    "9. Using Our Website",
    "10. Intellectual Property",
    "11. Limitation of Liability",
    "12. Governing Law & Disputes",
    "13. Contact Us",
  ];
  const r = renderLegalBody("", LEGAL_DEFAULT_HTML.terms, contact);
  assert.deepEqual(
    r.toc.map((t) => t.label),
    termsOrder,
  );
});

test("static file checks: pages, sidhu, cart", () => {
  const terms = readFileSync(path.join(root, "app/terms/page.tsx"), "utf8");
  const privacy = readFileSync(path.join(root, "app/privacy-policy/page.tsx"), "utf8");
  const refund = readFileSync(path.join(root, "app/refund-policy/page.tsx"), "utf8");
  const sidhu = readFileSync(path.join(root, "app/sidhu/page.tsx"), "utf8");
  const cart = readFileSync(path.join(root, "app/cart/page.tsx"), "utf8");

  for (const [name, src, titleKey, updatedKey, contentKey, h1] of [
    ["terms", terms, "terms_title", "terms_updated", "terms_content", "Terms & Conditions"],
    ["privacy", privacy, "privacy_title", "privacy_updated", "privacy_content", "Privacy Policy"],
    ["refund", refund, "refund_title", "refund_updated", "refund_content", "Refund Policy"],
  ] as const) {
    assert.match(src, /renderLegalBody/, name);
    assert.ok(src.includes(`"${titleKey}"`), name);
    assert.ok(src.includes(`"${updatedKey}"`), name);
    assert.ok(src.includes(`"${contentKey}"`), name);
    assert.ok(src.includes(h1), name);
  }

  assert.ok(sidhu.includes("|| LEGAL_DEFAULT_HTML.terms"));
  assert.ok(sidhu.includes("|| LEGAL_DEFAULT_HTML.privacy"));
  assert.ok(sidhu.includes("|| LEGAL_DEFAULT_HTML.refund"));
  const prefixCount = (sidhu.match(/cart_policy_prefix/g) || []).length;
  assert.equal(prefixCount, 2);

  assert.ok(cart.includes("/terms"));
  assert.ok(cart.includes("/refund-policy"));
  assert.ok(cart.includes("cart_policy_prefix"));
});

test("shipping default: 9 h2 in order; checkout marker; no hard day/Rs numbers except 48 hours; links", () => {
  const html = LEGAL_DEFAULT_HTML.shipping;
  const countH2 = (s: string) => (s.match(/<h2>/g) || []).length;
  assert.equal(countH2(html), 9);
  const order = [
    "1. Overview",
    "2. Where We Deliver",
    "3. Delivery Charges",
    "4. Order Confirmation and Dispatch",
    "5. Delivery Times",
    "6. Tracking Your Order",
    "7. Receiving Your Parcel",
    "8. Failed or Refused Deliveries",
    "9. Contact Us",
  ];
  const r = renderLegalBody("", html, contact);
  assert.deepEqual(r.toc.map((t) => t.label), order);
  assert.match(html, /shown at checkout/);
  const without48 = html.replace(/within 48 hours/g, "within XX hours");
  assert.equal(/\b\d+\s*(day|days|working day|Rs|PKR)\b/i.test(without48), false);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/order-tracking"/);
  assert.match(html, /href="\/refund-policy"/);
  assert.match(LEGAL_DEFAULT_HTML.terms, /href="\/shipping-policy"/);
});

test("static: shipping page, sitemap, footer, layout canonical/robots", () => {
  const shippingPage = readFileSync(path.join(root, "app/shipping-policy/page.tsx"), "utf8");
  const shippingLayout = readFileSync(path.join(root, "app/shipping-policy/layout.tsx"), "utf8");
  const footer = readFileSync(path.join(root, "components/SiteFooter.tsx"), "utf8");
  const sitemap = readFileSync(path.join(root, "app/sitemap.ts"), "utf8");
  const sidhu = readFileSync(path.join(root, "app/sidhu/page.tsx"), "utf8");

  assert.match(shippingPage, /renderLegalBody/);
  assert.ok(shippingPage.includes('"shipping_title"'));
  assert.ok(shippingPage.includes('"shipping_updated"'));
  assert.ok(shippingPage.includes('"shipping_content"'));
  assert.ok(shippingPage.includes("Shipping Policy"));
  assert.ok(sidhu.includes("|| LEGAL_DEFAULT_HTML.shipping"));
  assert.ok(sidhu.includes("footer_shipping"));

  const smMatches = sitemap.match(/\/shipping-policy/g) || [];
  assert.equal(smMatches.length, 1);
  assert.ok(footer.includes("/shipping-policy"));
  assert.ok(footer.includes("footer_shipping"));
  assert.match(shippingLayout, /canonical: `\$\{SITE_URL\}\/shipping-policy`/);
  assert.match(shippingLayout, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/);
});
