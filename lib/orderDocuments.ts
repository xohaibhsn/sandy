/**
 * Pure helpers for admin order tools: WhatsApp click-to-chat links and
 * printable Invoice / Packing Slip HTML. No DOM APIs.
 */
import { canonicalPkMobile, digitsOnly } from "./customerIdentity";
import { escapeHtml } from "./contentHtml";
import { formatPrice } from "./site";

export type OrderDocItem = {
  product_name?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  line_total?: number | string | null;
};

export type OrderDocTaxLine = {
  label?: string | null;
  amount?: number | string | null;
  vat_amount?: number | string | null;
  inclusive?: boolean | null;
  prices_include_tax?: boolean | null;
};

export type OrderDocOrder = {
  order_id?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  delivery_address?: string | null;
  city?: string | null;
  province?: string | null;
  postcode?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  discount_amount?: number | string | null;
  coupon_code?: string | null;
  shipping_amount?: number | string | null;
  vat_amount?: number | string | null;
  total?: number | string | null;
  created_at_pkt?: string | null;
  courier_name?: string | null;
  tracking_number?: string | null;
  items?: OrderDocItem[] | null;
  tax_lines?: OrderDocTaxLine[] | null;
  tax_label?: string | null;
  prices_include_tax?: boolean | null;
};

export type OrderDocSettings = {
  invoice_business_name?: string;
  invoice_business_address?: string;
  invoice_business_phone?: string;
  invoice_ntn?: string;
  invoice_title?: string;
  invoice_footer_note?: string;
  wa_confirm_template?: string;
  wa_dispatch_template?: string;
};

export const ORDER_TOOLS_DEFAULTS: { [K in keyof Required<OrderDocSettings>]: string } = {
  invoice_business_name: "S&Y",
  invoice_business_address: "",
  invoice_business_phone: "",
  invoice_ntn: "",
  invoice_title: "Invoice",
  invoice_footer_note:
    "Goods once delivered can be returned as per our Refund Policy at sandy.com.pk/refund-policy.",
  wa_confirm_template:
    "Assalam-o-Alaikum {name}! Thank you for your order {order_id} at {store}. Total: {total} ({payment}). Please reply YES to confirm delivery to {city}.",
  wa_dispatch_template:
    "Assalam-o-Alaikum {name}! Your order {order_id} has been dispatched via {courier}. Tracking: {tracking}. Thank you for shopping with {store}.",
};

const WA_MAX_LEN = 1500;
const ITEMS_PREVIEW_MAX = 5;

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function money(v: unknown): string {
  return formatPrice(Number(v || 0));
}

function storeName(settings: OrderDocSettings): string {
  return str(settings.invoice_business_name) || ORDER_TOOLS_DEFAULTS.invoice_business_name;
}

function paymentLabel(method: unknown): string {
  const key = str(method).toLowerCase();
  if (key === "cod") return "COD";
  if (key === "jazzcash") return "JazzCash";
  if (key === "easypaisa") return "Easypaisa";
  if (key === "bank") return "Bank";
  return key || "—";
}

function formatItemsPreview(items: OrderDocItem[] | null | undefined): string {
  const list = Array.isArray(items) ? items : [];
  const parts: string[] = [];
  for (let i = 0; i < list.length && i < ITEMS_PREVIEW_MAX; i++) {
    const it = list[i];
    const qty = Number(it.quantity || 0);
    const name = str(it.product_name) || "Item";
    const qLabel = Number.isFinite(qty) && qty > 0 ? String(qty) : "1";
    parts.push(`${qLabel}× ${name}`);
  }
  const extra = list.length - ITEMS_PREVIEW_MAX;
  if (extra > 0) parts.push(`+${extra} more`);
  return parts.join(", ");
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    return match;
  });
}

/** Convert order phone to wa.me digits (92XXXXXXXXXX) or null when not a PK mobile. */
export function waMeDigitsFromPhone(phone: unknown): string | null {
  const digits = digitsOnly(str(phone));
  if (!digits) return null;
  const pk = canonicalPkMobile(digits);
  if (!pk || !/^03\d{9}$/.test(pk)) return null;
  return "92" + pk.slice(1);
}

export type WhatsAppLinkResult =
  | { ok: true; href: string }
  | { ok: false; reason: "invalid_phone" };

export function buildWhatsAppLink(
  order: OrderDocOrder,
  template: string,
  opts?: { settings?: OrderDocSettings }
): WhatsAppLinkResult {
  const wa = waMeDigitsFromPhone(order.customer_phone);
  if (!wa) return { ok: false, reason: "invalid_phone" };

  const settings = opts?.settings || {};
  const vars: Record<string, string> = {
    name: str(order.customer_name) || "Customer",
    order_id: str(order.order_id) || "",
    total: money(order.total),
    payment: paymentLabel(order.payment_method),
    city: str(order.city) || "",
    items: formatItemsPreview(order.items),
    courier: str(order.courier_name) || "",
    tracking: str(order.tracking_number) || "",
    store: storeName(settings),
  };

  let text = fillTemplate(template || "", vars).trim();
  if (text.length > WA_MAX_LEN) text = text.slice(0, WA_MAX_LEN);

  return {
    ok: true,
    href: `https://wa.me/${wa}?text=${encodeURIComponent(text)}`,
  };
}

function formatOrderDatePkt(raw: unknown): string {
  const s = str(raw);
  if (!s) return "";
  // Prefer parsing ISO / DB timestamps; fall back to the raw PKT string.
  const d = new Date(s);
  if (Number.isFinite(d.getTime())) {
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Karachi",
    });
  }
  return s;
}

function resolveTaxLines(order: OrderDocOrder): Array<{ label: string; amount: number; incl: boolean }> {
  const lines = Array.isArray(order.tax_lines) ? order.tax_lines : [];
  if (lines.length > 0) {
    return lines.map((ln) => {
      const amount = Number(ln.amount ?? ln.vat_amount ?? 0);
      const incl =
        ln.inclusive === true ||
        ln.prices_include_tax === true ||
        order.prices_include_tax === true;
      return {
        label: str(ln.label) || "Tax",
        amount: Number.isFinite(amount) ? amount : 0,
        incl,
      };
    });
  }
  const amount = Number(order.vat_amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return [];
  return [
    {
      label: str(order.tax_label) || "Tax",
      amount,
      incl: order.prices_include_tax === true,
    },
  ];
}

function isCodUnpaid(order: OrderDocOrder): boolean {
  const method = str(order.payment_method).toLowerCase();
  if (method !== "cod") return false;
  const status = str(order.payment_status).toLowerCase();
  if (status === "paid" || status === "received") return false;
  return true;
}

function printCss(): string {
  return `
@page { size: A4 portrait; margin: 16mm; }
* { box-sizing: border-box; }
body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 12px; line-height: 1.45; margin: 0; padding: 0; }
h1 { font-size: 22px; color: #5B21B6; margin: 0 0 8px; font-weight: 700; }
h2 { font-size: 14px; margin: 0 0 4px; color: #111; }
.muted { color: #555; }
.row { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.block { margin-bottom: 14px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #E5E5E5; vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #5B21B6; }
.num { text-align: right; white-space: nowrap; }
.totals td { border-bottom: none; padding: 3px 8px; }
.totals .grand { font-weight: 700; font-size: 14px; color: #5B21B6; }
.footer { margin-top: 24px; font-size: 11px; color: #444; }
.sign { margin-top: 36px; border-top: 1px solid #CCC; padding-top: 8px; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`.trim();
}

function businessBlockHtml(settings: OrderDocSettings): string {
  const name = str(settings.invoice_business_name);
  const address = str(settings.invoice_business_address);
  const phone = str(settings.invoice_business_phone);
  const ntn = str(settings.invoice_ntn);
  const parts: string[] = [];
  if (name) parts.push(`<div><strong>${escapeHtml(name)}</strong></div>`);
  if (address) parts.push(`<div class="muted">${escapeHtml(address).replace(/\n/g, "<br>")}</div>`);
  if (phone) parts.push(`<div class="muted">${escapeHtml(phone)}</div>`);
  if (ntn) parts.push(`<div class="muted">NTN / STRN: ${escapeHtml(ntn)}</div>`);
  return parts.length ? `<div class="block" data-business-block="1">${parts.join("")}</div>` : "";
}

export function buildInvoiceHtml(order: OrderDocOrder, settings: OrderDocSettings): string {
  const title = str(settings.invoice_title) || ORDER_TOOLS_DEFAULTS.invoice_title;
  const footer = str(settings.invoice_footer_note);
  const store = storeName(settings);
  const orderId = str(order.order_id);
  const date = formatOrderDatePkt(order.created_at_pkt);
  const items = Array.isArray(order.items) ? order.items : [];
  const discount = Number(order.discount_amount || 0);
  const shipping = Number(order.shipping_amount || 0);
  const taxLines = resolveTaxLines(order);

  let subtotal = 0;
  const itemRows = items
    .map((it) => {
      const qty = Number(it.quantity || 0);
      const unit = Number(it.price || 0);
      const line =
        it.line_total != null && it.line_total !== ""
          ? Number(it.line_total)
          : unit * (Number.isFinite(qty) ? qty : 0);
      subtotal += Number.isFinite(line) ? line : 0;
      return `<tr>
        <td>${escapeHtml(str(it.product_name) || "Item")}</td>
        <td class="num">${escapeHtml(String(Number.isFinite(qty) ? qty : ""))}</td>
        <td class="num">${escapeHtml(money(unit))}</td>
        <td class="num">${escapeHtml(money(line))}</td>
      </tr>`;
    })
    .join("");

  const customerBits = [
    str(order.customer_name) ? `<div><strong>${escapeHtml(str(order.customer_name))}</strong></div>` : "",
    str(order.customer_phone) ? `<div>${escapeHtml(str(order.customer_phone))}</div>` : "",
    str(order.customer_email) ? `<div>${escapeHtml(str(order.customer_email))}</div>` : "",
    str(order.delivery_address) ? `<div>${escapeHtml(str(order.delivery_address))}</div>` : "",
    [str(order.city), str(order.province), str(order.postcode)].filter(Boolean).length
      ? `<div>${escapeHtml([str(order.city), str(order.province), str(order.postcode)].filter(Boolean).join(", "))}</div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const taxRows = taxLines
    .map((ln) => {
      const suffix = ln.incl ? " (incl.)" : "";
      return `<tr><td>${escapeHtml(ln.label)}${escapeHtml(suffix)}</td><td class="num">${escapeHtml(money(ln.amount))}</td></tr>`;
    })
    .join("");

  const deliveryCell =
    Number.isFinite(shipping) && shipping > 0 ? escapeHtml(money(shipping)) : "Free";

  const discountRow =
    Number.isFinite(discount) && discount > 0
      ? `<tr><td>Discount${str(order.coupon_code) ? ` (${escapeHtml(str(order.coupon_code))})` : ""}</td><td class="num">− ${escapeHtml(money(discount))}</td></tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)} ${escapeHtml(orderId)}</title>
<style>${printCss()}</style>
</head>
<body>
  ${businessBlockHtml(settings)}
  <h1 data-doc-title="1">${escapeHtml(title)}</h1>
  <div class="row">
    <div>
      <div>Invoice no: <strong>${escapeHtml(orderId)}</strong></div>
      ${date ? `<div>Date: ${escapeHtml(date)}</div>` : ""}
      <div>Payment: ${escapeHtml(paymentLabel(order.payment_method))}${str(order.payment_status) ? ` · ${escapeHtml(str(order.payment_status))}` : ""}</div>
    </div>
    <div data-customer-block="1">${customerBits}</div>
  </div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line</th></tr></thead>
    <tbody>${itemRows || `<tr><td colspan="4">No items</td></tr>`}</tbody>
  </table>
  <table class="totals">
    <tbody>
      <tr><td>Subtotal</td><td class="num">${escapeHtml(money(subtotal))}</td></tr>
      ${discountRow}
      <tr><td>Delivery</td><td class="num">${deliveryCell}</td></tr>
      ${taxRows}
      <tr class="grand"><td>Grand total</td><td class="num">${escapeHtml(money(order.total))}</td></tr>
    </tbody>
  </table>
  ${footer ? `<div class="footer" data-footer-note="1">${escapeHtml(footer)}</div>` : ""}
  <div class="footer">Thank you for shopping with ${escapeHtml(store)}</div>
</body>
</html>`;
}

export function buildPackingSlipHtml(order: OrderDocOrder, settings: OrderDocSettings): string {
  const name = str(settings.invoice_business_name);
  const orderId = str(order.order_id);
  const date = formatOrderDatePkt(order.created_at_pkt);
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items
    .map((it) => {
      const qty = Number(it.quantity || 0);
      return `<tr>
        <td>${escapeHtml(str(it.product_name) || "Item")}</td>
        <td class="num">${escapeHtml(String(Number.isFinite(qty) ? qty : ""))}</td>
      </tr>`;
    })
    .join("");

  const shipTo = [
    str(order.customer_name) ? `<div><strong>${escapeHtml(str(order.customer_name))}</strong></div>` : "",
    str(order.customer_phone) ? `<div>${escapeHtml(str(order.customer_phone))}</div>` : "",
    str(order.delivery_address) ? `<div>${escapeHtml(str(order.delivery_address))}</div>` : "",
    [str(order.city), str(order.province), str(order.postcode)].filter(Boolean).length
      ? `<div>${escapeHtml([str(order.city), str(order.province), str(order.postcode)].filter(Boolean).join(", "))}</div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const paymentLine = isCodUnpaid(order)
    ? `Cash on Delivery: collect ${escapeHtml(money(order.total))}`
    : "Paid";

  const courier = str(order.courier_name);
  const tracking = str(order.tracking_number);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Packing slip ${escapeHtml(orderId)}</title>
<style>${printCss()}</style>
</head>
<body>
  ${name ? `<h2 data-business-name="1">${escapeHtml(name)}</h2>` : ""}
  <h1>Packing slip</h1>
  <div class="block">
    <div>Order: <strong>${escapeHtml(orderId)}</strong></div>
    ${date ? `<div>Date: ${escapeHtml(date)}</div>` : ""}
  </div>
  <div class="block" data-ship-to="1">
    <div class="muted">Ship to</div>
    ${shipTo}
  </div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th></tr></thead>
    <tbody>${itemRows || `<tr><td colspan="2">No items</td></tr>`}</tbody>
  </table>
  <div class="block" data-payment-line="1"><strong>${paymentLine}</strong></div>
  ${courier ? `<div>Courier: ${escapeHtml(courier)}</div>` : ""}
  ${tracking ? `<div>Tracking: ${escapeHtml(tracking)}</div>` : ""}
  <div class="sign">Packed by ________________&nbsp;&nbsp;&nbsp;Checked by ________________</div>
</body>
</html>`;
}
