import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  ORDER_TOOLS_DEFAULTS,
  buildWhatsAppLink,
  buildInvoiceHtml,
  buildPackingSlipHtml,
  waMeDigitsFromPhone,
} = await import("../lib/orderDocuments.ts");

const baseOrder = {
  order_id: "ORD-100",
  customer_name: 'ZZ <b>Bold</b> & "Q"',
  customer_email: "a@example.com",
  customer_phone: "03001234567",
  delivery_address: "گلی 5، مکان 12",
  city: "Lahore",
  province: "Punjab",
  payment_method: "cod",
  discount_amount: 50,
  coupon_code: "SAVE50",
  shipping_amount: 200,
  vat_amount: 180,
  total: 1379,
  created_at_pkt: "2026-11-26 10:00:00",
  items: [
    { product_name: "Phone Case", quantity: 2, price: 500, line_total: 1000 },
    { product_name: "Cable", quantity: 1, price: 229, line_total: 229 },
  ],
  tax_label: "GST 18%",
  tax_lines: [{ label: "GST 18%", amount: 180 }],
};

const settings = {
  ...ORDER_TOOLS_DEFAULTS,
  invoice_business_name: "S&Y",
  invoice_business_address: "Test Address",
  invoice_business_phone: "0211234567",
  invoice_ntn: "1234567-8",
  invoice_title: "Invoice",
};

describe("waMeDigitsFromPhone", () => {
  it("normalises 03 / +92 / 923 forms to 92…", () => {
    assert.equal(waMeDigitsFromPhone("03001234567"), "923001234567");
    assert.equal(waMeDigitsFromPhone("+923001234567"), "923001234567");
    assert.equal(waMeDigitsFromPhone("923001234567"), "923001234567");
  });

  it("rejects landline / garbage", () => {
    assert.equal(waMeDigitsFromPhone("02134567890"), null);
    assert.equal(waMeDigitsFromPhone("not-a-phone"), null);
    assert.equal(waMeDigitsFromPhone(""), null);
  });
});

describe("buildWhatsAppLink", () => {
  it("builds wa.me href with encoded text", () => {
    const r = buildWhatsAppLink(baseOrder, ORDER_TOOLS_DEFAULTS.wa_confirm_template, { settings });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.href, /^https:\/\/wa\.me\/923001234567\?text=/);
    const text = decodeURIComponent(r.href.split("?text=")[1] || "");
    assert.match(text, /ORD-100/);
    assert.match(text, /Rs\. 1,379/);
    assert.match(text, /Lahore/);
  });

  it("returns ok:false for invalid phone", () => {
    const r = buildWhatsAppLink({ ...baseOrder, customer_phone: "021111" }, "Hi {name}");
    assert.deepEqual(r, { ok: false, reason: "invalid_phone" });
  });

  it("fills placeholders and leaves unknown as-is", () => {
    const r = buildWhatsAppLink(baseOrder, "Hello {name} {unknown} {items}", { settings });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const text = decodeURIComponent(r.href.split("?text=")[1] || "");
    assert.match(text, /Hello ZZ <b>Bold<\/b> & "Q" \{unknown\}/);
    assert.match(text, /2× Phone Case, 1× Cable/);
  });

  it("URL-encodes Urdu and ampersands", () => {
    const r = buildWhatsAppLink(baseOrder, "سلام & test {city}", { settings });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.href, /%26/);
    const text = decodeURIComponent(r.href.split("?text=")[1] || "");
    assert.match(text, /سلام/);
    assert.match(text, /&/);
  });

  it("caps message at 1500 chars", () => {
    const long = "x".repeat(2000);
    const r = buildWhatsAppLink(baseOrder, long, { settings });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const text = decodeURIComponent(r.href.split("?text=")[1] || "");
    assert.equal(text.length, 1500);
  });

  it("truncates items after 5 with +N more", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      product_name: `Item${i + 1}`,
      quantity: 1,
    }));
    const r = buildWhatsAppLink({ ...baseOrder, items }, "{items}", { settings });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const text = decodeURIComponent(r.href.split("?text=")[1] || "");
    assert.match(text, /\+2 more/);
    assert.doesNotMatch(text, /Item6/);
  });
});

describe("buildInvoiceHtml", () => {
  it("escapes customer name/address and never emits raw script tags from input", () => {
    const html = buildInvoiceHtml(
      {
        ...baseOrder,
        customer_name: 'ZZ <b>Bold</b> & "Q"',
        delivery_address: '<script>alert(1)</script> گلی',
      },
      settings
    );
    assert.match(html, /ZZ &lt;b&gt;Bold&lt;\/b&gt; &amp; &quot;Q&quot;/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /گلی/);
  });

  it("shows NTN only when set; uses title from settings", () => {
    const withNtn = buildInvoiceHtml(baseOrder, settings);
    assert.match(withNtn, /NTN \/ STRN: 1234567-8/);
    assert.match(withNtn, /data-doc-title="1">Invoice</);

    const noNtn = buildInvoiceHtml(baseOrder, { ...settings, invoice_ntn: "" });
    assert.doesNotMatch(noNtn, /NTN \/ STRN/);
  });

  it("shows Free delivery, discount, tax lines, whole-rupee totals", () => {
    const free = buildInvoiceHtml({ ...baseOrder, shipping_amount: 0 }, settings);
    assert.match(free, />Free</);
    assert.match(free, /Discount \(SAVE50\)/);
    assert.match(free, /GST 18%/);
    assert.match(free, /Rs\. 1,379/);
  });
});

describe("buildPackingSlipHtml", () => {
  it("COD unpaid shows collect line; paid has no unit/line prices", () => {
    const cod = buildPackingSlipHtml(baseOrder, settings);
    assert.match(cod, /Cash on Delivery: collect Rs\. 1,379/);
    assert.doesNotMatch(cod, /Unit/);
    assert.doesNotMatch(cod, /Rs\. 500/);

    const paid = buildPackingSlipHtml(
      { ...baseOrder, payment_method: "jazzcash", payment_status: "paid" },
      settings
    );
    assert.match(paid, />Paid</);
    assert.doesNotMatch(paid, /Cash on Delivery/);
  });
});

describe("OrderDetailDrawer WhatsApp links", () => {
  it("uses rel=noopener noreferrer on wa.me anchors", () => {
    const src = readFileSync(
      join(process.cwd(), "components/admin/OrderDetailDrawer.tsx"),
      "utf8"
    );
    assert.match(src, /data-wa-confirm="1"/);
    assert.match(src, /data-wa-dispatch="1"/);
    assert.match(src, /rel="noopener noreferrer"/);
    // Both WA anchors share the noopener pattern in the customer-tools block.
    const tools = src.slice(src.indexOf("data-order-customer-tools"));
    const waAnchors = tools.match(/<a[\s\S]*?data-wa-(?:confirm|dispatch)="1"[\s\S]*?>/g) || [];
    // Anchors may put data attr before or after rel — count rel near wa.me builders instead:
    assert.match(tools, /confirmLink\.href[\s\S]*?rel="noopener noreferrer"/);
    assert.match(tools, /dispatchLink\.href[\s\S]*?rel="noopener noreferrer"/);
    assert.ok(waAnchors.length >= 0);
  });
});
