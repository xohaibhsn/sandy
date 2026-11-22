import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import crypto from 'crypto';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import { isMailConfigured, sendMailSafe } from '../../lib/mailer';
import { buildStoreNewOrderEmail } from '../../lib/storeOrderEmail';
import { sendCustomerOrderEmail } from '../../lib/customerEmailDispatch';
import { getContactConfig } from '../../lib/contact-config';
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
import { loadShippingSettings } from '../../lib/shippingSettings';
import { hasDeliveryOpsSchema, hasShippingSchema } from '../../lib/shippingSchema';
import {
  AREA_NOT_SERVED_MESSAGE,
  AREA_REQUIRED_MESSAGE,
  enrichZonesWithDeliveryOps,
  isShippableItem,
  loadShippingZones,
  loadZoneDeliveryMethods,
  quoteShippingFromLines,
  type QuoteLine,
  type ShippingArea,
} from '../../lib/shipping';
import { loadShippingAreas } from '../../lib/shippingAreas';
import { loadActivePickupPoint, parseDeliveryOpsInput } from '../../lib/deliveryOpsInput';
import { nextOrderId } from '../../lib/orderId';

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
  /** Only present when shipping_enabled = 1 (city is already part of the fingerprint). */
  shippingExtras?: {
    province: string;
  };
  /**
   * BATCH-17: each field is present ONLY when its flag is on (areas => area_id, pickup => fulfilment +
   * pickup_point_id). Appended last so a flags-off fingerprint is byte-identical to ab26978.
   */
  opsExtras?: {
    area_id?: number | null;
    fulfilment?: string;
    pickup_point_id?: number | null;
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

  if (input.shippingExtras) {
    canonical.province = input.shippingExtras.province;
  }

  if (input.opsExtras) {
    if (input.opsExtras.area_id !== undefined) canonical.area_id = input.opsExtras.area_id;
    if (input.opsExtras.fulfilment !== undefined) canonical.fulfilment = input.opsExtras.fulfilment;
    if (input.opsExtras.pickup_point_id !== undefined) {
      canonical.pickup_point_id = input.opsExtras.pickup_point_id;
    }
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
  /** Present only when shipping_enabled = 1 (selected conditionally). */
  stock?: unknown;
  requires_shipping?: unknown;
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
  /** Present only when shipping_enabled = 1 (selected conditionally). */
  shipping_amount?: unknown;
  shipping_zone?: unknown;
  /** Present only when shipping_areas_enabled / pickup_enabled (BATCH-17). */
  shipping_area?: unknown;
  fulfilment?: unknown;
  pickup_point_name?: unknown;
};

type SnapshotLabelRow = RowDataPacket & { tax_label: unknown };

function parseTaxClassId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  contact: ContactConfig,
  shippingOn = false,
  opsFlags: { areasOn: boolean; pickupOn: boolean } = { areasOn: false, pickupOn: false }
): Promise<Record<string, unknown> | null> {
  const [orderRows] = await pool.query<OrderRow[]>(
    `SELECT order_id, total, coupon_code, discount_amount, vat_amount${
      shippingOn ? ', shipping_amount, shipping_zone' : ''
    }${opsFlags.areasOn ? ', shipping_area' : ''}${
      opsFlags.pickupOn ? ', fulfilment, pickup_point_name' : ''
    }
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

  // Flag off: shipping is always 0 (unchanged). Flag on: the amount stored at create time.
  let shipping = 0;
  let shippingZone: string | null = null;
  if (shippingOn) {
    const storedShipping = parseDbMoney(order.shipping_amount ?? 0);
    if (storedShipping === null) return null;
    shipping = storedShipping;
    const zoneRaw = order.shipping_zone;
    shippingZone = typeof zoneRaw === 'string' && zoneRaw.trim() ? zoneRaw.trim() : null;
  }

  return {
    tax_label,
    success: true,
    order_id: String(order.order_id),
    whatsappUrl: contact.whatsappUrl,
    telegramUrl: contact.telegramUrl,
    subtotal: subtotalResult.amount,
    shipping,
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
    ...(shippingOn ? { shipping_zone: shippingZone } : {}),
    ...(opsFlags.areasOn
      ? {
          shipping_area:
            typeof order.shipping_area === 'string' && order.shipping_area.trim()
              ? order.shipping_area.trim()
              : null,
        }
      : {}),
    ...(opsFlags.pickupOn
      ? {
          fulfilment: String(order.fulfilment ?? '') === 'pickup' ? 'pickup' : 'delivery',
          pickup_point_name:
            typeof order.pickup_point_name === 'string' && order.pickup_point_name.trim()
              ? order.pickup_point_name.trim()
              : null,
        }
      : {}),
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
    // Shipping flags are read here (cached) because a pickup order does not need an address.
    const shippingSettings = await loadShippingSettings();
    const shippingOn = shippingSettings.shipping_enabled;
    // Delivery ops (BATCH-17). Every flag needs shipping_enabled; with all of them off the parser
    // returns the delivery defaults without reading the body (ab26978 behaviour).
    const areasOn = shippingOn && shippingSettings.shipping_areas_enabled;
    const restrictOn = shippingOn && shippingSettings.shipping_restrict_to_zones;
    const pickupOn = shippingOn && shippingSettings.pickup_enabled;
    const ops = parseDeliveryOpsInput(body, { areasOn, pickupOn });
    if (!ops) return res.status(400).json({ error: 'Invalid request' });
    const isPickup = pickupOn && ops.fulfilment === 'pickup';
    if (
      !customer_name.value ||
      !customer_email.value ||
      !customer_phone.value ||
      (!isPickup && (!delivery_address.value || !city.value || !postcode.value))
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

    // Shipping (BATCH-12). Flag off => shipping stays 0 with NO new reads, columns or response keys.
    let shippingProvince = '';
    if (shippingOn) {
      const provinceRaw = readStringField(body.province, FIELD_MAX.city);
      if (!provinceRaw.ok) {
        return res.status(400).json({ error: 'Invalid request' });
      }
      shippingProvince = provinceRaw.value;
    }

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
      ...(shippingOn ? { shippingExtras: { province: shippingProvince } } : {}),
      ...(areasOn || pickupOn
        ? {
            opsExtras: {
              ...(areasOn ? { area_id: ops.areaId } : {}),
              ...(pickupOn
                ? { fulfilment: ops.fulfilment, pickup_point_id: ops.pickupPointId }
                : {}),
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

    // Migration 0009 must be applied before shipping can be charged (never a wrong total).
    if (shippingOn && !(await hasShippingSchema(pool))) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    // Migration 0010 must be applied before any delivery-ops flag can affect an order.
    if ((areasOn || restrictOn || pickupOn) && !(await hasDeliveryOpsSchema(pool))) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    // Flag off: always 0. Flag on: computed server-side below, after the coupon discount is known.
    let shipping = 0;
    let shippingZoneName: string | null = null;
    let shippingAreaSnapshot: string | null = null;
    let pickupPointId: number | null = null;
    let pickupPointName: string | null = null;
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

        const replay = await buildAuthoritativeReplayResponse(existingOrderId, contact, shippingOn, {
          areasOn,
          pickupOn,
        });
        if (!replay) {
          return res.status(500).json({ error: 'Unable to place order' });
        }
        return res.status(200).json(replay);
      }

      // First-create path only — product/coupon validation after successful claim.
      order_id = nextOrderId();

      const ids = normalizedItems.items.map((item) => item.id);
      const placeholders = ids.map(() => '?').join(',');
      let productRows: ProductRow[];
      try {
        [productRows] = await connection.query<ProductRow[]>(
          `SELECT id, name, price, active, track_inventory, stock_quantity, tax_class_id${
            shippingOn ? ', stock, requires_shipping' : ''
          }
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

      if (shippingOn) {
        // Server-authoritative shipping from the validated address + the shippable lines AFTER the
        // coupon discount (free_min base). The coupon base above was goods-only, so there is no cycle.
        try {
          const lines: QuoteLine[] = authoritativeItems.map((item) => {
            const p = byId.get(item.product_id);
            return {
              price: item.price,
              quantity: item.quantity,
              shippable: isShippableItem({
                requires_shipping: p?.requires_shipping,
                stock: p?.stock,
                track_inventory: p?.track_inventory,
              }),
            };
          });
          const baseZones = await loadShippingZones(connection);
          const zones =
            areasOn || restrictOn || pickupOn
              ? enrichZonesWithDeliveryOps(baseZones, await loadZoneDeliveryMethods(connection))
              : baseZones;
          if (isPickup) {
            // Pickup: the point must exist and be active; its name is snapshotted on the order.
            if (ops.pickupPointId === null) throw new OrderHttpError(400, 'Invalid request');
            const point = await loadActivePickupPoint(connection, ops.pickupPointId);
            if (!point) throw new OrderHttpError(400, 'Invalid request');
            pickupPointId = point.id;
            pickupPointName = point.name;
          }
          let areas: ShippingArea[] | undefined;
          if (!isPickup) {
            if (areasOn) areas = await loadShippingAreas(connection);
            else if (restrictOn) areas = [];
          }
          const quote = quoteShippingFromLines({
            zones,
            lines,
            city: city.value,
            province: shippingProvince,
            discountAmount: discount_amount,
            goodsSubtotal: subtotal,
            ...(areas !== undefined ? { areas, restrictToZones: restrictOn } : {}),
            ...(areasOn ? { areaId: ops.areaId, otherArea: ops.otherArea, requireAreaSelection: true } : {}),
            ...(pickupOn ? { fulfilment: ops.fulfilment, pickupEnabled: true } : {}),
          });
          if (quote.unavailable) {
            // Items need shipping but no zone (not even a default) applies: fail closed.
            throw new OrderHttpError(503, 'Service unavailable');
          }
          if (quote.deliverable === false) {
            // restrict-to-zones: nothing is written (the attempt claim rolls back with the transaction).
            if (quote.areaRequired) {
              throw new OrderHttpError(409, AREA_REQUIRED_MESSAGE, 'SHIPPING_AREA_REQUIRED');
            }
            throw new OrderHttpError(409, AREA_NOT_SERVED_MESSAGE, 'SHIPPING_AREA_NOT_SERVED');
          }
          shipping = quote.amount;
          shippingZoneName = quote.zoneName;
          shippingAreaSnapshot = quote.shippingAreaSnapshot ?? null;
        } catch (shipErr) {
          if (shipErr instanceof OrderHttpError) throw shipErr;
          console.error('[orders] Shipping computation failed');
          throw new OrderHttpError(503, 'Service unavailable');
        }
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
      let otpConsumedOrderId: string | null = null;
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
          otpConsumedOrderId = order_id;
          const consumed = await consumeVerificationToken(connection, {
            token: verificationToken,
            phoneNorm,
            orderId: otpConsumedOrderId,
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

      // BATCH-17 snapshot columns: only written when their flag is on (flags off => the ab26978 INSERT).
      const opsInsertCols: string[] = [];
      const opsInsertValues: unknown[] = [];
      if (areasOn) {
        opsInsertCols.push('shipping_area');
        opsInsertValues.push(shippingAreaSnapshot);
      }
      if (pickupOn) {
        opsInsertCols.push('fulfilment', 'pickup_point_id', 'pickup_point_name');
        opsInsertValues.push(isPickup ? 'pickup' : 'delivery', pickupPointId, pickupPointName);
      }
      const opsColsSql = opsInsertCols.length ? ',' + opsInsertCols.join(',') : '';
      const opsPlaceholdersSql = opsInsertCols.length ? ',' + opsInsertCols.map(() => '?').join(',') : '';

      // ER_DUP_ENTRY on order_id: regenerate ORD-<ms> (strictly increasing) and retry ≤3 times.
      let orderInserted = false;
      for (let idAttempt = 0; idAttempt < 3 && !orderInserted; idAttempt++) {
        try {
          if (protectionOn) {
            await connection.query(
              `INSERT INTO orders (
              order_id,customer_name,customer_email,customer_phone,delivery_address,city,postcode,notes,
              payment_method,receipt_path,total,coupon_code,discount_amount,vat_amount,payment_reference,status,
              customer_phone_norm,customer_email_norm,risk_score,risk_reasons,otp_verified,
              advance_amount,advance_reference,advance_receipt_path${shippingOn ? ',shipping_amount,shipping_zone' : ''}${opsColsSql}
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${shippingOn ? ',?,?' : ''}${opsPlaceholdersSql})`,
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
                ...(shippingOn ? [shipping, shippingZoneName] : []),
                ...opsInsertValues,
              ]
            );
          } else {
            await connection.query(
              'INSERT INTO orders (order_id,customer_name,customer_email,customer_phone,delivery_address,city,postcode,notes,payment_method,receipt_path,total,coupon_code,discount_amount,vat_amount,payment_reference,status' +
                (shippingOn ? ',shipping_amount,shipping_zone' : '') +
                opsColsSql +
                ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?' +
                (shippingOn ? ',?,?' : '') +
                opsPlaceholdersSql +
                ')',
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
                ...(shippingOn ? [shipping, shippingZoneName] : []),
                ...opsInsertValues,
              ]
            );
          }
          orderInserted = true;
        } catch (insErr) {
          if (protectionOn && isMissingColumnError(insErr)) {
            throw new OrderHttpError(503, 'Service unavailable');
          }
          if (isMysqlDupEntry(insErr) && idAttempt < 2) {
            order_id = nextOrderId();
            continue;
          }
          throw insErr;
        }
      }

      // Finding 62: consumeVerificationToken stamped the pre-retry id; keep challenge in sync.
      if (otpVerified === 1 && otpConsumedOrderId && order_id !== otpConsumedOrderId) {
        await connection.query(
          'UPDATE otp_challenges SET consumed_order_id = ? WHERE consumed_order_id = ?',
          [order_id, otpConsumedOrderId]
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
        if (isMailConfigured()) {
          const storeMail = buildStoreNewOrderEmail({
            to: contact.email,
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
          });
          void sendMailSafe(storeMail, { kind: 'store_new_order', orderId: order_id });
        }
      } catch (emailErr) {
        console.error('[orders] Email notification setup failed:', emailErr);
      }

      // Customer "order received" email: flag-gated (default OFF), fire-and-forget, never alters the response.
      void sendCustomerOrderEmail({
        kind: 'received',
        order: {
          orderId: order_id,
          customerName: customer_name.value,
          customerEmail: customer_email.value,
          items: authoritativeItems.map((i) => ({
            name: i.product_name,
            qty: i.quantity,
            lineTotal: i.price * i.quantity,
          })),
          shipping,
          shippingZoneName,
          shippingOn,
          taxLabel,
          taxAmount: vat_amount,
          discountAmount: discount_amount,
          discountLabel: persistedCoupon ?? undefined,
          grandTotal: total,
          paymentMethod: payment_method,
          contactEmail: contact.email,
        },
      });
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
      ...(shippingOn ? { shipping_zone: shippingZoneName } : {}),
      ...(areasOn ? { shipping_area: shippingAreaSnapshot } : {}),
      ...(pickupOn
        ? { fulfilment: isPickup ? 'pickup' : 'delivery', pickup_point_name: pickupPointName }
        : {}),
    });
  } catch (error: unknown) {
    if (error instanceof OrderHttpError) {
      return res.status(error.status).json({
        error: error.clientError,
        ...(error.code ? { code: error.code } : {}),
      });
    }
    if (isTaxConfigUnavailableError(error)) {
      return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
    }
    console.error('[orders] Unexpected failure:', error);
    return res.status(500).json({ error: 'Unable to place order' });
  }
}
