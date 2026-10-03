import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import nodemailer from 'nodemailer';
import { getContactConfig } from '../../lib/contact-config';
import { ORDERS_FROM_EMAIL, SITE_NAME, SITE_URL, TAX_LABEL, TAX_RATE, formatPrice } from '../../lib/site';
import { ensureShopTables } from '../../lib/ensureShopTables';
import {
  normalizeRequestItems,
  calculateSubtotal,
  calculateCouponDiscount,
  calculateOrderTotals,
  type PricedLineItem,
} from '../../lib/orderPricing';
import { assertSafeReceiptUrl, UrlValidationError } from '../../lib/urlValidation';

const ALLOWED_PAYMENT_METHODS = new Set(['cod', 'jazzcash', 'easypaisa', 'bank']);

const FIELD_MAX = {
  customer_name: 255,
  customer_email: 255,
  customer_phone: 50,
  city: 100,
  postcode: 100,
  payment_reference: 255,
  receipt_path: 500,
  delivery_address: 2000,
  notes: 4000,
  coupon_code: 50,
} as const;

class OrderHttpError extends Error {
  status: number;
  clientError: string;

  constructor(status: number, clientError: string) {
    super(clientError);
    this.name = 'OrderHttpError';
    this.status = status;
    this.clientError = clientError;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept string or nullish; reject objects/arrays/numbers. */
function readStringField(
  value: unknown,
  max: number
): { ok: true; value: string } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

/** Convert MySQL DECIMAL (number|string) to a finite non-negative number. */
function parseDbMoney(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
  return null;
}

function isActiveFlag(value: unknown): boolean {
  return Number(value) === 1;
}

function normalizePaymentMethod(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const method = raw.trim().toLowerCase();
  if (method === 'bank_transfer') return 'bank';
  if (ALLOWED_PAYMENT_METHODS.has(method)) return method;
  return null;
}

type ProductRow = RowDataPacket & {
  id: number;
  name: string;
  price: unknown;
  active: unknown;
};

type CouponRow = RowDataPacket & {
  code: string;
  type: string;
  value: unknown;
  minimum_order: unknown;
  usage_limit: number | null;
  used_count: number;
  expires_at: unknown;
  is_active: unknown;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = RL_GENERAL(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const body = req.body as Record<string, unknown>;

    // Legacy client may still send total / vat_amount / discount_amount / item.name / item.price.
    // Those fields are intentionally ignored for financial authority.

    const customer_name = readStringField(body.customer_name, FIELD_MAX.customer_name);
    const customer_email = readStringField(body.customer_email, FIELD_MAX.customer_email);
    const customer_phone = readStringField(body.customer_phone, FIELD_MAX.customer_phone);
    const delivery_address = readStringField(body.delivery_address, FIELD_MAX.delivery_address);
    const city = readStringField(body.city, FIELD_MAX.city);
    const postcode = readStringField(body.postcode, FIELD_MAX.postcode);
    const notes = readStringField(body.notes, FIELD_MAX.notes);
    const receipt_path = readStringField(body.receipt_path, FIELD_MAX.receipt_path);
    const payment_reference = readStringField(body.payment_reference, FIELD_MAX.payment_reference);

    if (
      !customer_name.ok ||
      !customer_email.ok ||
      !customer_phone.ok ||
      !delivery_address.ok ||
      !city.ok ||
      !postcode.ok ||
      !notes.ok ||
      !receipt_path.ok ||
      !payment_reference.ok
    ) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Committed checkout UI requires these contact/address fields (postal code + notes optional).
    // readStringField already trims, so empty / whitespace-only values are rejected here.
    if (
      !customer_name.value ||
      !customer_email.value ||
      !customer_phone.value ||
      !delivery_address.value ||
      !city.value ||
      !postcode.value
    ) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const payment_method = normalizePaymentMethod(body.payment_method);
    if (!payment_method) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const normalizedItems = normalizeRequestItems(body.items);
    if (!normalizedItems.ok) {
      return res.status(400).json({ error: 'Invalid cart items' });
    }

    let couponInput: string | null = null;
    if (body.coupon_code !== undefined && body.coupon_code !== null && body.coupon_code !== '') {
      if (typeof body.coupon_code !== 'string') {
        return res.status(400).json({ error: 'Invalid request' });
      }
      const code = body.coupon_code.trim().toUpperCase();
      if (code.length > FIELD_MAX.coupon_code) {
        return res.status(400).json({ error: 'Invalid request' });
      }
      if (code.length > 0) couponInput = code;
    }

    let safeReceiptPath = '';
    try {
      safeReceiptPath = assertSafeReceiptUrl(receipt_path.value);
    } catch (err) {
      if (err instanceof UrlValidationError) {
        return res.status(400).json({ error: 'Invalid receipt reference' });
      }
      throw err;
    }

    await ensureShopTables();

    // Fail before creating an order if contact config cannot be retrieved.
    const contact = await getContactConfig();

    const shipping = 0;
    const order_id = 'ORD-' + Date.now();

    let authoritativeItems: PricedLineItem[] = [];
    let subtotal = 0;
    let vat_amount = 0;
    let discount_amount = 0;
    let total = 0;
    let persistedCoupon: string | null = null;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const ids = normalizedItems.items.map((item) => item.id);
      const placeholders = ids.map(() => '?').join(',');
      const [productRows] = await connection.query<ProductRow[]>(
        `SELECT id, name, price, active FROM products WHERE id IN (${placeholders})`,
        ids
      );

      const byId = new Map<number, ProductRow>();
      for (const row of productRows) {
        byId.set(Number(row.id), row);
      }

      if (byId.size !== ids.length) {
        throw new OrderHttpError(400, 'One or more products are unavailable');
      }

      authoritativeItems = [];
      for (const reqItem of normalizedItems.items) {
        const product = byId.get(reqItem.id);
        if (!product) {
          throw new OrderHttpError(400, 'One or more products are unavailable');
        }
        if (!isActiveFlag(product.active)) {
          throw new OrderHttpError(400, 'One or more products are unavailable');
        }

        const price = parseDbMoney(product.price);
        if (price === null) {
          throw new OrderHttpError(500, 'Unable to place order');
        }

        authoritativeItems.push({
          product_id: reqItem.id,
          product_name: String(product.name ?? ''),
          price,
          quantity: reqItem.qty,
        });
      }

      const subtotalResult = calculateSubtotal(authoritativeItems);
      if (!subtotalResult.ok) {
        throw new OrderHttpError(500, 'Unable to place order');
      }
      subtotal = subtotalResult.amount;

      if (couponInput) {
        const [couponRows] = await connection.query<CouponRow[]>(
          `SELECT code, type, value, minimum_order, usage_limit, used_count, expires_at, is_active
           FROM coupons WHERE code = ? FOR UPDATE`,
          [couponInput]
        );

        if (!couponRows.length) {
          throw new OrderHttpError(400, 'Coupon is invalid or unavailable');
        }

        const coupon = couponRows[0];
        if (!isActiveFlag(coupon.is_active)) {
          throw new OrderHttpError(400, 'Coupon is invalid or unavailable');
        }

        if (coupon.expires_at && new Date(coupon.expires_at as string | Date) < new Date()) {
          throw new OrderHttpError(400, 'Coupon is invalid or unavailable');
        }

        if (coupon.usage_limit !== null && coupon.usage_limit !== undefined) {
          const usedCount = Number(coupon.used_count);
          const usageLimit = Number(coupon.usage_limit);
          if (!Number.isFinite(usedCount) || !Number.isFinite(usageLimit)) {
            throw new OrderHttpError(500, 'Unable to place order');
          }
          if (usedCount >= usageLimit) {
            throw new OrderHttpError(400, 'Coupon is invalid or unavailable');
          }
        }

        const couponBase = subtotal + shipping;
        const minimumOrder = parseDbMoney(coupon.minimum_order ?? 0);
        if (minimumOrder === null) {
          throw new OrderHttpError(500, 'Unable to place order');
        }
        if (couponBase < minimumOrder) {
          throw new OrderHttpError(400, 'Coupon is invalid or unavailable');
        }

        const couponValue = parseDbMoney(coupon.value);
        if (couponValue === null) {
          throw new OrderHttpError(500, 'Unable to place order');
        }

        const discountResult = calculateCouponDiscount(
          couponBase,
          coupon.type,
          couponValue
        );
        if (!discountResult.ok) {
          throw new OrderHttpError(500, 'Unable to place order');
        }

        discount_amount = discountResult.discount_amount;
        persistedCoupon = String(coupon.code);
      } else {
        discount_amount = 0;
        persistedCoupon = null;
      }

      const totalsResult = calculateOrderTotals({
        subtotal,
        shipping,
        taxRate: TAX_RATE,
        discountAmount: discount_amount,
      });
      if (!totalsResult.ok) {
        throw new OrderHttpError(500, 'Unable to place order');
      }

      vat_amount = totalsResult.totals.vat_amount;
      total = totalsResult.totals.total;
      discount_amount = totalsResult.totals.discount_amount;
      subtotal = totalsResult.totals.subtotal;

      await connection.query(
        'INSERT INTO orders (order_id,customer_name,customer_email,customer_phone,delivery_address,city,postcode,notes,payment_method,receipt_path,total,coupon_code,discount_amount,vat_amount,payment_reference,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          order_id,
          customer_name.value,
          customer_email.value,
          customer_phone.value,
          delivery_address.value,
          city.value,
          postcode.value,
          notes.value,
          payment_method,
          safeReceiptPath,
          total,
          persistedCoupon,
          discount_amount,
          vat_amount,
          payment_reference.value || null,
          'pending',
        ]
      );

      for (const item of authoritativeItems) {
        await connection.query(
          'INSERT INTO order_items (order_id,product_id,product_name,price,quantity) VALUES (?,?,?,?,?)',
          [order_id, item.product_id, item.product_name, item.price, item.quantity]
        );
      }

      if (persistedCoupon) {
        const [updateResult] = await connection.query<ResultSetHeader>(
          'UPDATE coupons SET used_count = used_count + 1 WHERE code = ?',
          [persistedCoupon]
        );
        if (updateResult.affectedRows !== 1) {
          throw new OrderHttpError(500, 'Unable to place order');
        }
      }

      await connection.commit();
    } catch (txError) {
      try {
        await connection.rollback();
      } catch {
        /* ignore rollback failure */
      }

      if (txError instanceof OrderHttpError) {
        return res.status(txError.status).json({ error: txError.clientError });
      }

      console.error('[orders] Transaction failed:', txError);
      return res.status(500).json({ error: 'Unable to place order' });
    } finally {
      try {
        connection.release();
      } catch (releaseErr) {
        // Never let release failure turn a committed order into a client 500.
        console.error('[orders] Connection release failed:', releaseErr);
      }
    }

    // Fire-and-forget email AFTER commit — notification failure must not roll back or 500.
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const transporter = nodemailer.createTransport({
          host: 'smtp.hostinger.com',
          port: 465,
          secure: true,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });

        const itemRows = authoritativeItems
          .map(
            (i) =>
              `<tr>
          <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:14px">${i.product_name}</td>
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

        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:620px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
  <div style="background:#5B21B6;padding:28px 32px">
    <h2 style="color:#fff;margin:0;font-size:22px;letter-spacing:1px">🛍️ New Order Received</h2>
    <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px">${SITE_URL.replace(/^https?:\/\//, '')}</p>
  </div>
  <div style="padding:28px 32px">
    <div style="background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:14px 20px;margin-bottom:24px;display:inline-block">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#7C3AED;margin-bottom:4px;font-weight:700">Order Reference</div>
      <div style="font-size:20px;font-weight:700;color:#5B21B6">${order_id}</div>
    </div>
    <h3 style="color:#111;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0f0f0">Customer Details</h3>
    <table style="width:100%;margin-bottom:24px;border-collapse:collapse">
      <tr><td style="padding:5px 0;color:#888;font-size:13px;width:110px">Name</td><td style="color:#111;font-size:13px;font-weight:600">${customer_name.value}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Email</td><td style="color:#111;font-size:13px">${customer_email.value}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Phone</td><td style="color:#111;font-size:13px">${customer_phone.value}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Address</td><td style="color:#111;font-size:13px">${[delivery_address.value, city.value, postcode.value].filter(Boolean).join(', ')}</td></tr>
      <tr><td style="padding:5px 0;color:#888;font-size:13px">Payment</td><td style="color:#111;font-size:13px;font-weight:600">${paymentLabel}</td></tr>
      ${payment_reference.value ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Reference</td><td style="color:#111;font-size:13px">${payment_reference.value}</td></tr>` : ''}
      ${notes.value ? `<tr><td style="padding:5px 0;color:#888;font-size:13px">Notes</td><td style="color:#111;font-size:13px">${notes.value}</td></tr>` : ''}
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
      ${vat_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px"><span style="color:#888">${TAX_LABEL}</span><span style="color:#111">${formatPrice(vat_amount)}</span></div>` : ''}
      ${discount_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#16A34A"><span>Discount${persistedCoupon ? ` (${persistedCoupon})` : ''}</span><span>−${formatPrice(discount_amount)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-size:18px;font-weight:700;border-top:1px solid #e5e5e5;margin-top:6px"><span style="color:#111">Grand Total</span><span style="color:#5B21B6">${formatPrice(total)}</span></div>
    </div>
  </div>
  <div style="background:#f9f9f9;padding:14px 32px;border-top:1px solid #e5e5e5;text-align:center">
    <p style="color:#aaa;font-size:12px;margin:0">Automated notification from ${SITE_URL.replace(/^https?:\/\//, '')}</p>
  </div>
</div></body></html>`;

        transporter
          .sendMail({
            from: `"${SITE_NAME} Orders" <${ORDERS_FROM_EMAIL}>`,
            to: contact.email,
            subject: `🛍️ New Order ${order_id} — ${customer_name.value}`,
            html,
          })
          .catch((err: unknown) => console.error('[orders] Email notification failed:', err));
      }
    } catch (emailErr) {
      console.error('[orders] Email notification setup failed:', emailErr);
    }

    return res.status(200).json({
      success: true,
      order_id,
      whatsappUrl: contact.whatsappUrl,
      telegramUrl: contact.telegramUrl,
      subtotal,
      shipping,
      vat_amount,
      discount_amount,
      total,
      coupon_code: persistedCoupon,
      items: authoritativeItems.map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name,
        price: item.price,
        quantity: item.quantity,
      })),
    });
  } catch (error: unknown) {
    if (error instanceof OrderHttpError) {
      return res.status(error.status).json({ error: error.clientError });
    }
    console.error('[orders] Unexpected failure:', error);
    return res.status(500).json({ error: 'Unable to place order' });
  }
}
