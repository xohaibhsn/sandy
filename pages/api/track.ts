import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getClientIp, rateLimit } from '../../lib/rateLimit';

const TRACK_LIMIT = 15;
const TRACK_WINDOW_MS = 15 * 60 * 1000;
const ORDER_ID_MAX = 50;
const EMAIL_MAX = 254;
const LOOKUP_FAIL = { error: 'Order not found or details do not match' };
const INFRA_FAIL = { error: 'Unable to look up order' };

function setPrivacyHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function normalizeOrderId(raw: unknown): string | null {
  if (!isPlainString(raw)) return null;
  const orderId = raw.trim();
  if (!orderId || orderId.length > ORDER_ID_MAX) return null;
  if (hasControlChars(orderId)) return null;
  return orderId;
}

function normalizeEmail(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isPlainString(raw)) return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  if (hasControlChars(email)) return null;
  return email;
}

function normalizePhoneDigits(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isPlainString(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 32) return null;
  return digits;
}

function emailsMatch(provided: string, stored: unknown): boolean {
  if (typeof stored !== 'string') return false;
  const storedNorm = stored.trim().toLowerCase();
  if (!storedNorm) return false;
  return provided === storedNorm;
}

function phonesMatch(providedDigits: string, stored: unknown): boolean {
  if (typeof stored !== 'string') return false;
  const storedDigits = stored.replace(/\D/g, '');
  if (!storedDigits) return false;
  return providedDigits === storedDigits;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setPrivacyHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { allowed } = rateLimit(`track:${getClientIp(req)}`, TRACK_LIMIT, TRACK_WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const orderId = normalizeOrderId(body.order_id);
  const email = normalizeEmail(body.email);
  const phoneDigits = normalizePhoneDigits(body.phone);

  // Missing/invalid inputs, or no usable verifier → same public failure (no DB).
  if (!orderId || (!email && !phoneDigits)) {
    return res.status(404).json(LOOKUP_FAIL);
  }

  try {
    const [orderResult] = await pool.query(
      `SELECT order_id, status, created_at, total, customer_email, customer_phone
       FROM orders
       WHERE order_id = ?
       LIMIT 1`,
      [orderId]
    );
    const rows = orderResult as Array<{
      order_id: string;
      status: string;
      created_at: string | Date;
      total: number | string;
      customer_email: string | null;
      customer_phone: string | null;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json(LOOKUP_FAIL);
    }

    const row = rows[0];
    const emailOk = email ? emailsMatch(email, row.customer_email) : false;
    const phoneOk = phoneDigits ? phonesMatch(phoneDigits, row.customer_phone) : false;
    if (!emailOk && !phoneOk) {
      return res.status(404).json(LOOKUP_FAIL);
    }

    const [itemResult] = await pool.query(
      `SELECT product_name, price, quantity
       FROM order_items
       WHERE order_id = ?
       ORDER BY id ASC`,
      [orderId]
    );
    const items = itemResult as Array<{
      product_name: string;
      price: number | string;
      quantity: number;
    }>;

    return res.status(200).json({
      order: {
        order_id: row.order_id,
        status: row.status,
        created_at: row.created_at,
        total: row.total,
      },
      items: Array.isArray(items)
        ? items.map((it) => ({
            product_name: it.product_name,
            quantity: it.quantity,
            price: it.price,
          }))
        : [],
    });
  } catch {
    return res.status(500).json(INFRA_FAIL);
  }
}
