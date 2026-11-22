/**
 * Store-side "New Order Received" email builder, moved verbatim out of pages/api/orders.ts
 * (SANDY-BATCH-48). The template literal contents are byte-identical to the previous inline code;
 * tests/customer-emails.test.ts pins the output against a golden fixture.
 */
import { ORDERS_FROM_EMAIL, SITE_NAME, SITE_URL, formatPrice } from './site';
import { escapeHtml, escapeHtmlMultiline, sanitizeSubjectPart, SUBJECT_NAME_MAX } from './emailText';

type Field = { value: string };

export type StoreNewOrderEmailInput = {
  to: string;
  order_id: string;
  customer_name: Field;
  customer_email: Field;
  customer_phone: Field;
  delivery_address: Field;
  city: Field;
  postcode: Field;
  notes: Field;
  payment_method: string;
  payment_reference: Field;
  authoritativeItems: { product_name: string; quantity: number; price: number }[];
  shippingOn: boolean;
  shipping: number;
  shippingZoneName: string | null;
  isPickup: boolean;
  pickupPointName: string | null;
  areasOn: boolean;
  shippingAreaSnapshot: string | null;
  taxLabel: string;
  vat_amount: number;
  discount_amount: number;
  persistedCoupon: string | null;
  total: number;
};

export function buildStoreNewOrderEmail(input: StoreNewOrderEmailInput): {
  from: string;
  to: string;
  subject: string;
  html: string;
} {
  const {
    to,
    order_id,
    customer_name,
    customer_email,
    customer_phone,
    delivery_address,
    city,
    postcode,
    notes,
    payment_method,
    payment_reference,
    authoritativeItems,
    shippingOn,
    shipping,
    shippingZoneName,
    isPickup,
    pickupPointName,
    areasOn,
    shippingAreaSnapshot,
    taxLabel,
    vat_amount,
    discount_amount,
    persistedCoupon,
    total,
  } = input;

          const itemRows = authoritativeItems
            .map(
              (i) =>
                `<tr>
          <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:14px">${escapeHtml(i.product_name)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:14px">${i.quantity}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:14px;font-weight:600;color:#5B21B6">${formatPrice(i.price * i.quantity)}</td>
        </tr>`
            )
            .join('');

          const paymentLabel =
            payment_method === 'cod'
              ? 'Cash on Delivery'
              : payment_method === 'jazzcash'
                ? 'JazzCash'
                : payment_method === 'easypaisa'
                  ? 'Easypaisa'
                  : payment_method === 'bank'
                    ? 'Bank Transfer'
                    : payment_method;

          // Shipping row only when the flag is on AND there is something to show; flag off => ''.
          const shippingRowHtml =
            shippingOn && (shipping > 0 || shippingZoneName)
              ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px"><span style="color:#888">Shipping${shippingZoneName ? ` (${escapeHtml(shippingZoneName)})` : ''}</span><span style="color:#111">${shipping > 0 ? formatPrice(shipping) : 'Free'}</span></div>`
              : '';

          const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:620px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
  <div style="background:#5B21B6;padding:28px 32px">
    <h2 style="color:#fff;margin:0;font-size:22px;letter-spacing:1px">🛍️ New Order Received</h2>
    <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px">${SITE_URL.replace(/^https?:\/\//, '')}</p>
  </div>
  <div style="padding:28px 32px">
    <div style="background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:14px 20px;margin-bottom:24px;display:inline-block">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#7C3AED;margin-bottom:4px;font-weight:700">Order Reference</div>
      <div style="font-size:20px;font-weight:700;color:#5B21B6">${escapeHtml(order_id)}</div>
    </div>
    <h3 style="color:#111;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0f0f0">Customer Details</h3>
    <table style="width:100%;margin-bottom:24px;border-collapse:collapse">
      <tr><td style="padding:5px 0;color:#888;font-size:13px;width:110px">Name</td><td style="color:#111;font-size:13px;font-weight:600">${escapeHtml(customer_name.value)}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Email</td><td style="color:#111;font-size:13px">${escapeHtml(customer_email.value)}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Phone</td><td style="color:#111;font-size:13px">${escapeHtml(customer_phone.value)}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Address</td><td style="color:#111;font-size:13px">${[delivery_address.value, city.value, postcode.value].filter(Boolean).map((part) => escapeHtml(part)).join(', ')}</td></tr>
      ${isPickup && pickupPointName ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Pickup at</td><td style="color:#111;font-size:13px;font-weight:600">${escapeHtml(pickupPointName)}</td></tr>` : ''}
      ${areasOn && shippingAreaSnapshot ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Area</td><td style="color:#111;font-size:13px">${escapeHtml(shippingAreaSnapshot)}</td></tr>` : ''}
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Payment</td><td style="color:#111;font-size:13px;font-weight:600">${escapeHtml(paymentLabel)}</td></tr>
      ${payment_reference.value ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Reference</td><td style="color:#111;font-size:13px">${escapeHtml(payment_reference.value)}</td></tr>` : ''}
      ${notes.value ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Notes</td><td style="color:#111;font-size:13px">${escapeHtmlMultiline(notes.value)}</td></tr>` : ''}
    </table>
    <h3 style="color:#111;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0f0f0">Order Items</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <thead><tr style="background:#f9f9f9">
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888;font-weight:700;letter-spacing:1px;text-transform:uppercase">Product</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#888;font-weight:700;letter-spacing:1px;text-transform:uppercase">Qty</th>
        <th style="padding:10px 14px;text-align:right;font-size:11px;color:#888;font-weight:700;letter-spacing:1px;text-transform:uppercase">Total</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:10px;padding:16px 20px">
      ${shippingRowHtml}${vat_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px"><span style="color:#888">${escapeHtml(taxLabel)}</span><span style="color:#111">${formatPrice(vat_amount)}</span></div>` : ''}
      ${discount_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#16A34A"><span>Discount${persistedCoupon ? ` (${escapeHtml(persistedCoupon)})` : ''}</span><span>−${formatPrice(discount_amount)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-size:18px;font-weight:700;border-top:1px solid #e5e5e5;margin-top:6px"><span style="color:#111">Grand Total</span><span style="color:#5B21B6">${formatPrice(total)}</span></div>
    </div>
  </div>
  <div style="background:#f9f9f9;padding:14px 32px;border-top:1px solid #e5e5e5;text-align:center">
    <p style="color:#aaa;font-size:12px;margin:0">Automated notification from ${SITE_URL.replace(/^https?:\/\//, '')}</p>
  </div>
</div></body></html>`;

  return {
    from: `"${SITE_NAME} Orders" <${ORDERS_FROM_EMAIL}>`,
    to,
    subject: `🛍️ New Order ${sanitizeSubjectPart(order_id, 64)} — ${sanitizeSubjectPart(customer_name.value, SUBJECT_NAME_MAX)}`,
    html,
  };
}
