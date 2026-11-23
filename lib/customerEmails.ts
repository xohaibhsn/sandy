/**
 * Pure builders for customer-facing order emails (received / confirmed).
 * No I/O. Every dynamic value is HTML-escaped; subjects are single-line; no phone or address is included.
 */
import { SITE_NAME, SITE_URL, formatPrice } from './site';
import { escapeHtml, isValidCustomerEmail, sanitizeSubjectPart } from './emailText';
import { resolveMailFromAddress } from './mailer';

export { sanitizeSubjectPart, isValidCustomerEmail };

export type CustomerEmailOrder = {
  orderId: string;
  customerName: string;
  customerEmail: string;
  items: { name: string; qty: number; lineTotal: number }[];
  shipping?: number;
  shippingZoneName?: string | null;
  shippingOn?: boolean;
  taxLabel?: string;
  taxAmount?: number;
  discountAmount?: number;
  /** Coupon label shown next to the discount line. */
  discountLabel?: string;
  grandTotal: number;
  /** Raw payment method key (cod / jazzcash / easypaisa / bank) or an already-friendly label. */
  paymentMethod: string;
  /** Store contact email, used as Reply-To when present and valid. */
  contactEmail?: string | null;
};

export type CustomerEmailMessage = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

type Kind = 'received' | 'confirmed';

const SUBJECT_ORDER_ID_MAX = 64;

export function paymentMethodLabel(method: string): string {
  const m = String(method ?? '');
  return m === 'cod'
    ? 'Cash on Delivery'
    : m === 'jazzcash'
      ? 'JazzCash'
      : m === 'easypaisa'
        ? 'Easypaisa'
        : m === 'bank'
          ? 'Bank Transfer'
          : m;
}

/** Plain text safe for a single line: control characters collapsed, trimmed. */
function oneLine(s: string, max = 120): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function firstName(full: string): string {
  const first = oneLine(full).split(' ')[0] || '';
  return first || 'there';
}

function money(n: unknown): string {
  const v = Number(n);
  return formatPrice(Number.isFinite(v) ? v : 0);
}

function build(kind: Kind, order: CustomerEmailOrder): CustomerEmailMessage {
  const orderId = oneLine(order.orderId, 120);
  const name = firstName(order.customerName);
  const lead =
    kind === 'received'
      ? 'Thank you for your order. We have received it and our team will contact you to confirm it.'
      : 'Your order has been confirmed. Our team will contact you about delivery.';
  const heading = kind === 'received' ? 'Order received' : 'Order confirmed';
  const subject = `${heading} — ${sanitizeSubjectPart(String(order.orderId ?? ''), SUBJECT_ORDER_ID_MAX)}`;
  const trackUrl = `${SITE_URL}/order-tracking`;
  const siteHost = SITE_URL.replace(/^https?:\/\//, '');

  const shipping = Number(order.shipping ?? 0);
  const zone = order.shippingZoneName ? oneLine(order.shippingZoneName) : '';
  const showShipping = shipping > 0 || (!!order.shippingOn && !!zone);
  const taxAmount = Number(order.taxAmount ?? 0);
  const taxLabel = oneLine(order.taxLabel || 'Tax', 60) || 'Tax';
  const discountAmount = Number(order.discountAmount ?? 0);
  const discountLabel = order.discountLabel ? oneLine(order.discountLabel, 60) : '';
  const payment = oneLine(paymentMethodLabel(order.paymentMethod), 60);

  const items = (order.items || []).map((i) => ({
    name: oneLine(i.name, 200),
    qty: Number.isFinite(Number(i.qty)) ? Math.trunc(Number(i.qty)) : 0,
    lineTotal: Number(i.lineTotal),
  }));

  // ---- plain text
  const textLines: string[] = [
    `Hi ${name},`,
    '',
    lead,
    '',
    `Order: ${orderId}`,
    '',
    'Items:',
    ...items.map((i) => `- ${i.name} x ${i.qty} — ${money(i.lineTotal)}`),
    '',
  ];
  if (showShipping) {
    textLines.push(`Shipping${zone ? ` (${zone})` : ''}: ${shipping > 0 ? money(shipping) : 'Free'}`);
  }
  if (taxAmount > 0) textLines.push(`${taxLabel}: ${money(taxAmount)}`);
  if (discountAmount > 0) {
    textLines.push(`Discount${discountLabel ? ` (${discountLabel})` : ''}: -${money(discountAmount)}`);
  }
  textLines.push(`Total: ${money(order.grandTotal)}`, `Payment: ${payment}`, '', `Track your order: ${trackUrl}`, '');
  textLines.push(`This is an automated message from ${SITE_NAME}.`);
  const text = textLines.join('\n');

  // ---- html
  const itemRows = items
    .map(
      (i) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px">${escapeHtml(i.name)}</td>` +
        `<td style="padding:8px 8px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:14px">${escapeHtml(String(i.qty))}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px">${escapeHtml(money(i.lineTotal))}</td></tr>`
    )
    .join('');
  const row = (label: string, value: string, color = '#111') =>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span style="color:#888">${label}</span><span style="color:${color}">${value}</span></div>`;
  const summaryRows = [
    showShipping
      ? row(
          `Shipping${zone ? ` (${escapeHtml(zone)})` : ''}`,
          escapeHtml(shipping > 0 ? money(shipping) : 'Free')
        )
      : '',
    taxAmount > 0 ? row(escapeHtml(taxLabel), escapeHtml(money(taxAmount))) : '',
    discountAmount > 0
      ? row(
          `Discount${discountLabel ? ` (${escapeHtml(discountLabel)})` : ''}`,
          `&minus;${escapeHtml(money(discountAmount))}`,
          '#16A34A'
        )
      : '',
  ].join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
  <div style="background:#5B21B6;padding:22px 28px">
    <h2 style="color:#fff;margin:0;font-size:20px">${escapeHtml(heading)}</h2>
    <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:13px">${escapeHtml(siteHost)}</p>
  </div>
  <div style="padding:24px 28px;color:#111">
    <p style="margin:0 0 12px;font-size:15px">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 18px;font-size:14px;color:#444">${escapeHtml(lead)}</p>
    <p style="margin:0 0 18px;font-size:13px;color:#888">Order <strong style="color:#5B21B6;font-size:15px">${escapeHtml(orderId)}</strong></p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tbody>${itemRows}</tbody></table>
    <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:10px;padding:12px 16px">
      ${summaryRows}
      <div style="display:flex;justify-content:space-between;padding:8px 0 2px;font-size:16px;font-weight:700"><span>Total</span><span style="color:#5B21B6">${escapeHtml(money(order.grandTotal))}</span></div>
    </div>
    <p style="margin:16px 0 0;font-size:13px;color:#444">Payment: <strong>${escapeHtml(payment)}</strong></p>
    <p style="margin:18px 0 0;font-size:14px"><a href="${escapeHtml(trackUrl)}" style="color:#5B21B6">Track your order</a></p>
  </div>
  <div style="background:#f9f9f9;padding:12px 28px;border-top:1px solid #e5e5e5;text-align:center">
    <p style="color:#aaa;font-size:12px;margin:0">This is an automated message from ${escapeHtml(SITE_NAME)}.</p>
  </div>
</div></body></html>`;

  const replyTo =
    order.contactEmail && isValidCustomerEmail(order.contactEmail) ? order.contactEmail.trim() : undefined;

  return {
    from: `"${SITE_NAME} Orders" <${resolveMailFromAddress()}>`,
    to: String(order.customerEmail ?? '').trim(),
    ...(replyTo ? { replyTo } : {}),
    subject,
    html,
    text,
  };
}

export function buildOrderReceivedEmail(order: CustomerEmailOrder): CustomerEmailMessage {
  return build('received', order);
}

export function buildOrderConfirmedEmail(order: CustomerEmailOrder): CustomerEmailMessage {
  return build('confirmed', order);
}
