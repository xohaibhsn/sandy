import type { NextApiRequest, NextApiResponse } from 'next';
import type { RowDataPacket } from 'mysql2';
import pool from '../../lib/db';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import {
  normalizeRequestItems,
  calculateCouponDiscount,
  computeOrderTaxTotals,
  type TaxedPricedLineItem,
} from '../../lib/orderPricing';
import {
  TAX_CONFIG_UNAVAILABLE_MESSAGE,
  loadEffectiveTaxConfig,
  toTaxUnavailable,
} from '../../lib/taxStore';
import type { TaxDestination } from '../../lib/taxEngine';

/**
 * Public, read-only checkout quote. The browser never computes tax: it sends
 * {items:[{id,qty}], coupon?, destination?} and displays what this endpoint returns.
 * Prices, coupon discount and tax rates all come from the server/DB.
 * Writes nothing (no coupon usage increment, no inventory change).
 */

const COUPON_MAX = 50;
const UNAVAILABLE_PRODUCT = 'One or more products are unavailable';
const INVALID_COUPON = 'Coupon is invalid or unavailable';

type QuoteProductRow = RowDataPacket & {
  id: number;
  name: string;
  price: unknown;
  active: unknown;
  tax_class_id: unknown;
};

type QuoteCouponRow = RowDataPacket & {
  code: string;
  type: string;
  value: unknown;
  minimum_order: unknown;
  usage_limit: number | null;
  used_count: number;
  expires_at: unknown;
  is_active: unknown;
};

function parseDbMoney(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function parseTaxClassId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === 'ER_BAD_FIELD_ERROR';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = RL_GENERAL(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : null;
    if (!body) return res.status(400).json({ error: 'Invalid request' });

    const normalized = normalizeRequestItems(body.items);
    if (!normalized.ok) return res.status(400).json({ error: 'Invalid cart items' });

    let couponInput: string | null = null;
    const couponRaw = body.coupon ?? body.coupon_code;
    if (couponRaw !== undefined && couponRaw !== null && couponRaw !== '') {
      if (typeof couponRaw !== 'string') return res.status(400).json({ error: 'Invalid request' });
      const code = couponRaw.trim().toUpperCase();
      if (code.length > COUPON_MAX) return res.status(400).json({ error: 'Invalid request' });
      if (code.length > 0) couponInput = code;
    }

    let destination: TaxDestination = 'domestic';
    if (body.destination !== undefined && body.destination !== null && body.destination !== '') {
      if (body.destination !== 'domestic' && body.destination !== 'international') {
        return res.status(400).json({ error: 'Invalid request' });
      }
      destination = body.destination;
    }

    // Tax config first: missing tables => fail safe, never a guessed rate.
    let config: Awaited<ReturnType<typeof loadEffectiveTaxConfig>>;
    try {
      config = await loadEffectiveTaxConfig(pool, new Date());
    } catch (err) {
      const unavailable = toTaxUnavailable(err, 'tax-quote:loadEffectiveTaxConfig');
      return res.status(503).json({ error: unavailable.message });
    }

    const ids = normalized.items.map((i) => i.id);
    const placeholders = ids.map(() => '?').join(',');
    let productRows: QuoteProductRow[];
    try {
      [productRows] = await pool.query<QuoteProductRow[]>(
        `SELECT id, name, price, active, tax_class_id FROM products WHERE id IN (${placeholders})`,
        ids
      );
    } catch (err) {
      if (isMissingColumnError(err)) {
        toTaxUnavailable(err, 'tax-quote:products.tax_class_id');
        return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
      }
      throw err;
    }

    const byId = new Map<number, QuoteProductRow>();
    for (const row of productRows) byId.set(Number(row.id), row);
    if (byId.size !== ids.length) return res.status(400).json({ error: UNAVAILABLE_PRODUCT });

    const items: TaxedPricedLineItem[] = [];
    for (const reqItem of normalized.items) {
      const p = byId.get(reqItem.id);
      if (!p || (p.active !== null && p.active !== undefined && Number(p.active) !== 1)) {
        return res.status(400).json({ error: UNAVAILABLE_PRODUCT });
      }
      const price = parseDbMoney(p.price);
      if (price === null) return res.status(500).json({ error: 'Unable to calculate totals' });
      items.push({
        product_id: reqItem.id,
        product_name: String(p.name ?? ''),
        price,
        quantity: reqItem.qty,
        tax_class_id: parseTaxClassId(p.tax_class_id),
      });
    }

    const shipping = 0;
    const goodsSubtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    let discount = 0;
    let persistedCoupon: string | null = null;

    if (couponInput) {
      const [couponRows] = await pool.query<QuoteCouponRow[]>(
        `SELECT code, type, value, minimum_order, usage_limit, used_count, expires_at, is_active
         FROM coupons WHERE code = ?`,
        [couponInput]
      );
      const coupon = couponRows?.[0];
      if (!coupon || Number(coupon.is_active) !== 1) {
        return res.status(400).json({ error: INVALID_COUPON });
      }
      if (coupon.expires_at && new Date(coupon.expires_at as string | Date) < new Date()) {
        return res.status(400).json({ error: INVALID_COUPON });
      }
      if (coupon.usage_limit !== null && coupon.usage_limit !== undefined) {
        if (Number(coupon.used_count) >= Number(coupon.usage_limit)) {
          return res.status(400).json({ error: INVALID_COUPON });
        }
      }
      const base = Math.round((goodsSubtotal + shipping) * 100) / 100;
      const minimumOrder = parseDbMoney(coupon.minimum_order ?? 0);
      const couponValue = parseDbMoney(coupon.value);
      if (minimumOrder === null || couponValue === null) {
        return res.status(500).json({ error: 'Unable to calculate totals' });
      }
      if (base < minimumOrder) return res.status(400).json({ error: INVALID_COUPON });
      const d = calculateCouponDiscount(base, coupon.type, couponValue);
      if (!d.ok) return res.status(500).json({ error: 'Unable to calculate totals' });
      discount = d.discount_amount;
      persistedCoupon = String(coupon.code);
    }

    const result = computeOrderTaxTotals({
      items,
      discountAmount: discount,
      shipping,
      config,
      destination,
    });
    if (!result.ok) {
      if (result.error.startsWith('Tax ')) {
        console.error('[tax-quote] Tax computation failed:', result.error);
        return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
      }
      return res.status(500).json({ error: 'Unable to calculate totals' });
    }

    const t = result.totals;
    return res.status(200).json({
      success: true,
      destination,
      coupon_code: persistedCoupon,
      subtotal: t.subtotal,
      shipping: t.shipping,
      discount: t.discount_amount,
      discount_amount: t.discount_amount,
      tax_label: t.tax_label,
      prices_include_tax: t.prices_include_tax,
      tax_lines: result.tax.by_class.map((c) => ({
        tax_class_id: c.tax_class_id,
        tax_class_name: c.tax_class_name,
        rate_percent: c.rate_percent,
        taxable_amount: c.taxable_amount,
        tax_amount: c.tax_amount,
      })),
      vat_amount: t.vat_amount,
      total: t.total,
    });
  } catch (error: unknown) {
    console.error('[tax-quote] Unexpected failure:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Unable to calculate totals' });
  }
}
