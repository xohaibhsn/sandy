import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import crypto from 'crypto';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import nodemailer from 'nodemailer';
import { getContactConfig } from '../../lib/contact-config';
import { ORDERS_FROM_EMAIL, SITE_NAME, SITE_URL, formatPrice } from '../../lib/site';
import {
  TAX_CONFIG_UNAVAILABLE_MESSAGE,
  isTaxConfigUnavailableError,
  loadEffectiveTaxConfig,
  toTaxUnavailable,
} from '../../lib/taxStore';
import type { TaxDestination, TaxSnapshot } from '../../lib/taxEngine';
import {
  normalizeRequestItems,
  calculateSubtotal,
  calculateCouponDiscount,
  computeOrderTaxTotals,
  type TaxedPricedLineItem,
  type PricedLineItem,
  type RequestLineItem,
} from '../../lib/orderPricing';
import { assertSafeReceiptUrl, UrlValidationError } from '../../lib/urlValidation';
import { evaluateCheckoutProtection } from '../../lib/codProtection';
import { CUSTOMER_TEXTS } from '../../lib/customerTexts';
import { consumeVerificationToken } from '../../lib/otp';
import { loadOrderProtectionSettings } from '../../lib/orderProtectionSettings';
import { loadAccountSettings } from '../../lib/accountSettings';
import { getCustomerSession } from '../../lib/customerAuth';

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

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_STOCK_QUANTITY = 1_000_000;

class OrderHttpError extends Error {
  status: number;
  clientError: string;
  code?: string;

  constructor(status: number, clientError: string, code?: string) {
    super(clientError);
    this.name = 'OrderHttpError';
    this.status = status;
    this.clientError = clientError;
    this.code = code;
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

/** Canonical DB track_inventory: only 0 / 1 (and numeric-string equivalents). */
function parseDbTrackInventory(value: unknown): 0 | 1 | null {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

/** Canonical DB stock_quantity for tracked products: integer 0..MAX. */
function parseDbStockQuantity(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_STOCK_QUANTITY) {
      return null;
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK_QUANTITY) return null;
    return n;
  }
  return null;
}

function normalizePaymentMethod(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const method = raw.trim().toLowerCase();
  if (method === 'bank_transfer') return 'bank';
  if (ALLOWED_PAYMENT_METHODS.has(method)) return method;
  return null;
}

function parseIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!UUID_V4_RE.test(key)) return null;
  return key;
}

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === 'ER_BAD_FIELD_ERROR';
}

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE';
}

function isMysqlDupEntry(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1062 || e.code === 'ER_DUP_ENTRY';
}

function buildCheckoutFingerprint(input: {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  delivery_address: string;
  city: string;
  postcode: string;
  notes: string;
  payment_method: string;
  payment_reference: string;
  receipt_path: string;
  coupon_code: string;
  destination: TaxDestination;
  items: RequestLineItem[];
  /** When protection is on, include outcome-changing extras; omit entirely when off (parity). */
  protectionExtras?: {
    verification_token: string;
    advance_reference: string;
    advance_receipt_path: string;
  };
}): string {
  const items = [...input.items]
    .sort((a, b) => a.id - b.id)
    .map((item) => ({ id: item.id, qty: item.qty }));

  const canonical: Record<string, unknown> = {
    customer_name: input.customer_name,
    customer_email: input.customer_email,
    customer_phone: input.customer_phone,
    delivery_address: input.delivery_address,
    city: input.city,
    postcode: input.postcode,
    notes: input.notes,
    payment_method: input.payment_method,
    payment_reference: input.payment_reference,
    receipt_path: input.receipt_path,
    coupon_code: input.coupon_code,
    destination: input.destination,
    items,
  };

  if (input.protectionExtras) {
    canonical.verification_token = input.protectionExtras.verification_token;
    canonical.advance_reference = input.protectionExtras.advance_reference;
    canonical.advance_receipt_path = input.protectionExtras.advance_receipt_path;
  }

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

type ProductRow = RowDataPacket & {
  id: number;
  name: string;
  price: unknown;
  active: unknown;
  track_inventory: unknown;
  stock_quantity: unknown;
  tax_class_id: unknown;
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

type AttemptRow = RowDataPacket & {
  idempotency_key: string;
  request_fingerprint: string;
  order_id: string | null;
};

type OrderRow = RowDataPacket & {
  order_id: string;
  total: unknown;
  coupon_code: unknown;
  discount_amount: unknown;
  vat_amount: unknown;
};

type SnapshotLabelRow = RowDataPacket & { tax_label: unknown };

function parseTaxClassId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes user text for HTML and turns line breaks into <br>. */
function escapeHtmlMultiline(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

const SUBJECT_NAME_MAX = 80;

/** Single-line, control-character-free, length-capped text for an email subject header. */
function sanitizeSubjectPart(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

type OrderItemRow = RowDataPacket & {
  product_id: unknown;
  product_name: unknown;
  price: unknown;
  quantity: unknown;
};

type ContactConfig = Awaited<ReturnType<typeof getContactConfig>>;

async function buildAuthoritativeReplayResponse(
  orderId: string,
  contact: ContactConfig
): Promise<Record<string, unknown> | null> {
  const [orderRows] = await pool.query<OrderRow[]>(
    `SELECT order_id, total, coupon_code, discount_amount, vat_amount
     FROM orders WHERE order_id = ? LIMIT 1`,
    [orderId]
  );
  if (!orderRows.length) return null;

  const order = orderRows[0];
  const [itemRows] = await pool.query<OrderItemRow[]>(
    `SELECT product_id, product_name, price, quantity
     FROM order_items WHERE order_id = ? ORDER BY id ASC`,
    [orderId]
  );
  if (!itemRows.length) return null;

  const items: PricedLineItem[] = [];
  for (const row of itemRows) {
    const productId = Number(row.product_id);
    const quantity = Number(row.quantity);
    const price = parseDbMoney(row.price);
    if (!Number.isInteger(productId) || productId <= 0) return null;
    if (!Number.isInteger(quantity) || quantity <= 0) return null;
    if (price === null) return null;
    items.push({
      product_id: productId,
      product_name: String(row.product_name ?? ''),
      price,
      quantity,
    });
  }

  const subtotalResult = calculateSubtotal(items);
  if (!subtotalResult.ok) return null;

  const vat_amount = parseDbMoney(order.vat_amount);
  const discount_amount = parseDbMoney(order.discount_amount);
  const total = parseDbMoney(order.total);
  if (vat_amount === null || discount_amount === null || total === null) return null;

  const couponRaw = order.coupon_code;
  const coupon_code =
    typeof couponRaw === 'string' && couponRaw.trim() ? couponRaw.trim() : null;

  // Stored label from the order's own tax snapshot (null for pre-TAX-CONFIG orders).
  let tax_label: string | null = null;
  try {
    const [snapRows] = await pool.query<SnapshotLabelRow[]>(
      `SELECT tax_label FROM order_tax_snapshots WHERE order_id = ? LIMIT 1`,
      [orderId]
    );
    const label = snapRows?.[0]?.tax_label;
    tax_label = typeof label === 'string' && label.trim() ? label.trim() : null;
  } catch {
    tax_label = null;
  }

  return {
    tax_label,
    success: true,
    order_id: String(order.order_id),
    whatsappUrl: contact.whatsappUrl,
    telegramUrl: contact.telegramUrl,
    subtotal: subtotalResult.amount,
    shipping: 0,
    vat_amount,
    discount_amount,
    total,
    coupon_code,
    items: items.map((item) => ({
      product_id: item.product_id,
      product_name: item.product_name,
      price: item.price,
      quantity: item.quantity,
    })),
  };
}

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

    // Optional destination for applies_to rules. Defaults to domestic.
    // NOTE: there is no country field in checkout yet, so this is client-asserted (see TAX-CONFIG-SUMMARY gaps).
    let destination: TaxDestination = 'domestic';
    if (body.destination !== undefined && body.destination !== null && body.destination !== '') {
      if (body.destination !== 'domestic' && body.destination !== 'international') {
        return res.status(400).json({ error: 'Invalid request' });
      }
      destination = body.destination;
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

    const protectionSettings = await loadOrderProtectionSettings();
    const protectionOn = protectionSettings.cod_protection_enabled;

    const verificationToken =
      typeof body.verification_token === 'string' ? body.verification_token.trim() : '';
    const advanceReferenceRaw = readStringField(body.advance_reference, FIELD_MAX.payment_reference);
    if (!advanceReferenceRaw.ok) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const advanceReceiptRaw = readStringField(body.advance_receipt_path, FIELD_MAX.receipt_path);
    if (!advanceReceiptRaw.ok) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    let safeAdvanceReceiptPath = '';
    if (advanceReceiptRaw.value) {
      try {
        safeAdvanceReceiptPath = assertSafeReceiptUrl(advanceReceiptRaw.value);
      } catch (err) {
        if (err instanceof UrlValidationError) {
          return res.status(400).json({ error: 'Invalid receipt reference' });
        }
        throw err;
      }
    }

    const idempotencyKey = parseIdempotencyKey(body.idempotency_key);
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const fingerprint = buildCheckoutFingerprint({
      customer_name: customer_name.value,
      customer_email: customer_email.value,
      customer_phone: customer_phone.value,
      delivery_address: delivery_address.value,
      city: city.value,
      postcode: postcode.value,
      notes: notes.value,
      payment_method,
      payment_reference: payment_reference.value,
      receipt_path: safeReceiptPath,
      coupon_code: couponInput || '',
      destination,
      items: normalizedItems.items,
      ...(protectionOn
        ? {
            protectionExtras: {
              verification_token: verificationToken,
              advance_reference: advanceReferenceRaw.value,
              advance_receipt_path: safeAdvanceReceiptPath,
            },
          }
        : {}),
    });

    // Tax config is loaded server-side BEFORE any order state is created.
    // Missing/unreadable tax tables fail safe (503) — there is no hardcoded fallback rate.
    const taxAsOf = new Date();
    let taxConfig: Awaited<ReturnType<typeof loadEffectiveTaxConfig>>;
    try {
      taxConfig = await loadEffectiveTaxConfig(pool, taxAsOf);
    } catch (taxErr) {
      const unavailable = toTaxUnavailable(taxErr, 'orders:loadEffectiveTaxConfig');
      return res.status(503).json({ error: unavailable.message });
    }

    // Fail before creating an order if contact config cannot be retrieved.
    const contact = await getContactConfig();

    // Customer accounts (BATCH-09): resolved BEFORE taking the transaction connection (the pool is tiny;
    // a second pool query while holding one could starve under load). Flag off / guest / any lookup
    // failure => null => no stamping and checkout behaves exactly as before.
    let accountCustomerId: number | null = null;
    try {
      const accountSettings = await loadAccountSettings();
      if (accountSettings.accounts_enabled) {
        const { customer } = await getCustomerSession(req);
        if (customer) accountCustomerId = customer.id;
      }
    } catch {
      accountCustomerId = null;
    }

    const shipping = 0;
    let order_id = '';
    let createdNewOrder = false;

    let authoritativeItems: TaxedPricedLineItem[] = [];
    let subtotal = 0;
    let taxLabel = '';
    let taxLines: Array<{
      tax_class_id: number;
      tax_class_name: string;
      rate_percent: number;
      taxable_amount: number;
      tax_amount: number;
    }> = [];
    let taxSnapshot: TaxSnapshot | null = null;
    let vat_amount = 0;
    let discount_amount = 0;
    let total = 0;
    let persistedCoupon: string | null = null;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      try {
        await connection.query(
          `INSERT INTO order_checkout_attempts (idempotency_key, request_fingerprint, order_id)
           VALUES (?, ?, NULL)`,
          [idempotencyKey, fingerprint]
        );
      } catch (claimErr) {
        if (!isMysqlDupEntry(claimErr)) {
          throw claimErr;
        }

        try {
          await connection.rollback();
        } catch {
          /* ignore */
        }

        const [attemptRows] = await pool.query<AttemptRow[]>(
          `SELECT idempotency_key, request_fingerprint, order_id
           FROM order_checkout_attempts WHERE idempotency_key = ? LIMIT 1`,
          [idempotencyKey]
        );

        if (!attemptRows.length) {
          return res.status(409).json({ error: 'Checkout attempt conflict. Please try again.' });
        }

        const attempt = attemptRows[0];
        if (String(attempt.request_fingerprint) !== fingerprint) {
          return res.status(409).json({
            error: 'Checkout attempt does not match the original request',
          });
        }

        const existingOrderId =
          typeof attempt.order_id === 'string' ? attempt.order_id.trim() : '';
        if (!existingOrderId) {
          return res.status(409).json({ error: 'Checkout attempt conflict. Please try again.' });
        }

        const replay = await buildAuthoritativeReplayResponse(existingOrderId, contact);
        if (!replay) {
          return res.status(500).json({ error: 'Unable to place order' });
        }
        return res.status(200).json(replay);
      }

      // First-create path only — product/coupon validation after successful claim.
      order_id = 'ORD-' + Date.now();

      const ids = normalizedItems.items.map((item) => item.id);
      const placeholders = ids.map(() => '?').join(',');
      let productRows: ProductRow[];
      try {
        [productRows] = await connection.query<ProductRow[]>(
          `SELECT id, name, price, active, track_inventory, stock_quantity, tax_class_id
           FROM products
           WHERE id IN (${placeholders})
           ORDER BY id ASC
           FOR UPDATE`,
          ids
        );
      } catch (productErr) {
        // products.tax_class_id not migrated yet => fail safe, never guess a class.
        if (isMissingColumnError(productErr)) {
          toTaxUnavailable(productErr, 'orders:products.tax_class_id');
          throw new OrderHttpError(503, TAX_CONFIG_UNAVAILABLE_MESSAGE);
        }
        throw productErr;
      }

      const byId = new Map<number, ProductRow>();
      for (const row of productRows) {
        byId.set(Number(row.id), row);
      }

      if (byId.size !== ids.length) {
        throw new OrderHttpError(400, 'One or more products are unavailable');
      }

      type InventoryDecrement = {
        productId: number;
        previousQty: number;
        newQty: number;
      };
      const inventoryDecrements: InventoryDecrement[] = [];

      authoritativeItems = [];
      for (const reqItem of normalizedItems.items) {
        const product = byId.get(reqItem.id);
        if (!product) {
          throw new OrderHttpError(400, 'One or more products are unavailable');
        }
        // NULL active (legacy rows) is treated as active, matching public catalog reads.
        if (product.active !== null && product.active !== undefined && !isActiveFlag(product.active)) {
          throw new OrderHttpError(400, 'One or more products are unavailable');
        }

        const price = parseDbMoney(product.price);
        if (price === null) {
          throw new OrderHttpError(500, 'Unable to place order');
        }

        const track = parseDbTrackInventory(product.track_inventory);
        if (track === null) {
          throw new OrderHttpError(500, 'Unable to place order');
        }

        if (track === 1) {
          const stockQty = parseDbStockQuantity(product.stock_quantity);
          if (stockQty === null) {
            throw new OrderHttpError(500, 'Unable to place order');
          }
          if (reqItem.qty > stockQty) {
            throw new OrderHttpError(409, 'Insufficient stock for one or more products');
          }
          inventoryDecrements.push({
            productId: reqItem.id,
            previousQty: stockQty,
            newQty: stockQty - reqItem.qty,
          });
        }

        authoritativeItems.push({
          product_id: reqItem.id,
          product_name: String(product.name ?? ''),
          price,
          quantity: reqItem.qty,
          tax_class_id: parseTaxClassId(product.tax_class_id),
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

      const totalsResult = computeOrderTaxTotals({
        items: authoritativeItems,
        discountAmount: discount_amount,
        shipping,
        config: taxConfig,
        destination,
      });
      if (!totalsResult.ok) {
        if (totalsResult.error.startsWith('Tax ')) {
          console.error('[orders] Tax computation failed:', totalsResult.error);
          throw new OrderHttpError(503, TAX_CONFIG_UNAVAILABLE_MESSAGE);
        }
        throw new OrderHttpError(500, 'Unable to place order');
      }

      vat_amount = totalsResult.totals.vat_amount;
      total = totalsResult.totals.total;
      discount_amount = totalsResult.totals.discount_amount;
      subtotal = totalsResult.totals.subtotal;
      taxLabel = totalsResult.totals.tax_label;
      taxLines = totalsResult.tax.by_class.map((c) => ({
        tax_class_id: c.tax_class_id,
        tax_class_name: c.tax_class_name,
        rate_percent: c.rate_percent,
        taxable_amount: c.taxable_amount,
        tax_amount: c.tax_amount,
      }));
      taxSnapshot = totalsResult.tax.snapshot;

      let phoneNorm: string | null = null;
      let emailNorm: string | null = null;
      let riskScore: number | null = null;
      let riskReasons: string | null = null;
      let otpVerified: number | null = null;
      let advanceAmount: number | null = null;
      let advanceReference: string | null = null;
      let advanceReceiptPath: string | null = null;

      if (protectionOn) {
        const eval_ = await evaluateCheckoutProtection(connection, {
          phone: customer_phone.value,
          email: customer_email.value,
          orderTotal: total,
          paymentMethod: payment_method,
          clientIp: getClientIp(req),
        });
        phoneNorm = eval_.phoneNorm;
        emailNorm = eval_.emailNorm;
        riskScore = eval_.risk.score;
        riskReasons = eval_.risk.reasons.join(',');

        if (payment_method === 'cod' && !eval_.risk.codAllowed) {
          throw new OrderHttpError(
            409,
            CUSTOMER_TEXTS.COD_NOT_AVAILABLE,
            'COD_NOT_AVAILABLE'
          );
        }

        if (payment_method === 'cod' && eval_.risk.advanceDeliveryChargeRequired) {
          if (!advanceReferenceRaw.value) {
            throw new OrderHttpError(
              409,
              CUSTOMER_TEXTS.COD_NOT_AVAILABLE,
              'COD_NOT_AVAILABLE'
            );
          }
          advanceAmount = eval_.risk.advanceDeliveryCharge;
          advanceReference = advanceReferenceRaw.value;
          advanceReceiptPath = safeAdvanceReceiptPath || null;
        }

        if (payment_method === 'cod' && eval_.otpEffective) {
          if (!verificationToken) {
            throw new OrderHttpError(
              409,
              CUSTOMER_TEXTS.COD_NOT_AVAILABLE,
              'COD_NOT_AVAILABLE'
            );
          }
          if (!phoneNorm) {
            throw new OrderHttpError(
              409,
              CUSTOMER_TEXTS.COD_NOT_AVAILABLE,
              'COD_NOT_AVAILABLE'
            );
          }
          // order_id already assigned above for this txn
          const consumed = await consumeVerificationToken(connection, {
            token: verificationToken,
            phoneNorm,
            orderId: order_id,
          });
          if (!consumed.ok) {
            throw new OrderHttpError(
              409,
              CUSTOMER_TEXTS.COD_NOT_AVAILABLE,
              'COD_NOT_AVAILABLE'
            );
          }
          otpVerified = 1;
        } else if (protectionOn) {
          otpVerified = 0;
        }
      }

      if (protectionOn) {
        try {
          await connection.query(
            `INSERT INTO orders (
              order_id,customer_name,customer_email,customer_phone,delivery_address,city,postcode,notes,
              payment_method,receipt_path,total,coupon_code,discount_amount,vat_amount,payment_reference,status,
              customer_phone_norm,customer_email_norm,risk_score,risk_reasons,otp_verified,
              advance_amount,advance_reference,advance_receipt_path
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
              phoneNorm,
              emailNorm,
              riskScore,
              riskReasons,
              otpVerified,
              advanceAmount,
              advanceReference,
              advanceReceiptPath,
            ]
          );
        } catch (insErr) {
          if (isMissingColumnError(insErr)) {
            throw new OrderHttpError(503, 'Service unavailable');
          }
          throw insErr;
        }
      } else {
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
      }

      // Link the order to the signed-in customer (same transaction). Guests are untouched; a missing
      // orders.customer_id column (migration 0008 not applied) skips the stamp instead of failing checkout.
      if (accountCustomerId !== null) {
        try {
          await connection.query(
            'UPDATE orders SET customer_id = ? WHERE order_id = ? AND customer_id IS NULL',
            [accountCustomerId, order_id]
          );
        } catch (stampErr) {
          if (!isMissingColumnError(stampErr)) throw stampErr;
        }
      }

      for (const item of authoritativeItems) {
        await connection.query(
          'INSERT INTO order_items (order_id,product_id,product_name,price,quantity) VALUES (?,?,?,?,?)',
          [order_id, item.product_id, item.product_name, item.price, item.quantity]
        );
      }

      // Immutable per-order tax snapshot (rates/rules/label as applied). Same transaction as the order:
      // if it cannot be written the order is rolled back (fail safe, no untracked tax).
      if (!taxSnapshot) {
        throw new OrderHttpError(500, 'Unable to place order');
      }
      try {
        await connection.query(
          `INSERT INTO order_tax_snapshots (order_id, tax_label, vat_amount, snapshot_json)
           VALUES (?, ?, ?, ?)`,
          [order_id, taxLabel, vat_amount, JSON.stringify(taxSnapshot)]
        );
      } catch (snapErr) {
        if (isMissingTableError(snapErr) || isMissingColumnError(snapErr)) {
          toTaxUnavailable(snapErr, 'orders:order_tax_snapshots');
          throw new OrderHttpError(503, TAX_CONFIG_UNAVAILABLE_MESSAGE);
        }
        throw snapErr;
      }

      for (const dec of inventoryDecrements) {
        const [stockUpdate] = await connection.query<ResultSetHeader>(
          `UPDATE products
           SET stock_quantity = ?, stock = ?
           WHERE id = ?
             AND track_inventory = 1
             AND stock_quantity = ?`,
          [dec.newQty, String(dec.newQty), dec.productId, dec.previousQty]
        );
        if (stockUpdate.affectedRows !== 1) {
          throw new OrderHttpError(409, 'Insufficient stock for one or more products');
        }
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

      const [mapResult] = await connection.query<ResultSetHeader>(
        `UPDATE order_checkout_attempts SET order_id = ? WHERE idempotency_key = ?`,
        [order_id, idempotencyKey]
      );
      if (mapResult.affectedRows !== 1) {
        throw new OrderHttpError(500, 'Unable to place order');
      }

      await connection.commit();
      createdNewOrder = true;
    } catch (txError) {
      try {
        await connection.rollback();
      } catch {
        /* ignore rollback failure */
      }

      if (txError instanceof OrderHttpError) {
        return res.status(txError.status).json(
          txError.code
            ? { error: txError.clientError, code: txError.code }
            : { error: txError.clientError }
        );
      }

      console.error(
        '[orders] Transaction failed:',
        (txError as { code?: string; errno?: number })?.code ||
          (txError as { errno?: number })?.errno ||
          'unknown'
      );
      return res.status(500).json({ error: 'Unable to place order' });
    } finally {
      try {
        connection.release();
      } catch (releaseErr) {
        // Never let release failure turn a committed order into a client 500.
        console.error('[orders] Connection release failed:', releaseErr);
      }
    }

    // Fire-and-forget email AFTER commit — only for newly created orders.
    if (createdNewOrder) {
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
      ${vat_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px"><span style="color:#888">${escapeHtml(taxLabel)}</span><span style="color:#111">${formatPrice(vat_amount)}</span></div>` : ''}
      ${discount_amount ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;color:#16A34A"><span>Discount${persistedCoupon ? ` (${escapeHtml(persistedCoupon)})` : ''}</span><span>−${formatPrice(discount_amount)}</span></div>` : ''}
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
              subject: `🛍️ New Order ${sanitizeSubjectPart(order_id, 64)} — ${sanitizeSubjectPart(customer_name.value, SUBJECT_NAME_MAX)}`,
              html,
            })
            .catch((err: unknown) => console.error('[orders] Email notification failed:', err));
        }
      } catch (emailErr) {
        console.error('[orders] Email notification setup failed:', emailErr);
      }
    }

    return res.status(200).json({
      success: true,
      order_id,
      whatsappUrl: contact.whatsappUrl,
      telegramUrl: contact.telegramUrl,
      subtotal,
      shipping,
      vat_amount,
      tax_label: taxLabel,
      tax_lines: taxLines,
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
    if (isTaxConfigUnavailableError(error)) {
      return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
    }
    console.error('[orders] Unexpected failure:', error);
    return res.status(500).json({ error: 'Unable to place order' });
  }
}
