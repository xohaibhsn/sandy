import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getClientIp, rateLimit } from '../../lib/rateLimit';
import { hasCancelReasonColumn } from '../../lib/orderCancel';
import { canonicalPkMobile } from '../../lib/customerIdentity';
import { hasDeliveryOpsOrderColumns, hasShippingOrderColumns } from '../../lib/shippingSchema';
import { buildTrackingUrl } from '../../lib/shipping';
import { loadShippingSettings } from '../../lib/shippingSettings';
import {
  deliveredLabel,
  isPickupOrder,
  ownRiderTrackingLabel,
  readyForPickupLabel,
} from '../../lib/shippingStatus';

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
  const providedPk = canonicalPkMobile(providedDigits);
  const storedPk = canonicalPkMobile(storedDigits);
  if (providedPk && storedPk) return providedPk === storedPk;
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
    const includeCancelReason = await hasCancelReasonColumn(pool);
    const selectCols = includeCancelReason
      ? `order_id, status, cancel_reason, created_at, total, vat_amount, customer_email, customer_phone`
      : `order_id, status, created_at, total, vat_amount, customer_email, customer_phone`;

    // Courier / tracking number only exist after migration 0009; without it the query is unchanged.
    const includeShipping = await hasShippingOrderColumns(pool);
    let selectColsFinal = includeShipping ? `${selectCols}, courier_id, tracking_number` : selectCols;

    // Delivery ops (BATCH-17, migration 0010): own rider / pickup details. Selected only when shipping
    // (or pickup) is enabled AND the columns exist; otherwise the query and response are unchanged.
    let includeOps = false;
    {
      const s = await loadShippingSettings();
      if ((s.shipping_enabled || s.pickup_enabled) && (await hasDeliveryOpsOrderColumns(pool))) {
        includeOps = true;
        selectColsFinal = `${selectColsFinal}, fulfilment, rider_id, pickup_point_id, pickup_point_name`;
      }
    }

    const [orderResult] = await pool.query(
      `SELECT ${selectColsFinal}
       FROM orders
       WHERE order_id = ?
       LIMIT 1`,
      [orderId]
    );
    const rows = orderResult as Array<{
      order_id: string;
      status: string;
      cancel_reason?: string | null;
      created_at: string | Date;
      total: number | string;
      vat_amount?: number | string | null;
      customer_email: string | null;
      customer_phone: string | null;
      courier_id?: number | string | null;
      tracking_number?: string | null;
      fulfilment?: string | null;
      rider_id?: number | string | null;
      pickup_point_id?: number | string | null;
      pickup_point_name?: string | null;
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

    const orderPayload: {
      order_id: string;
      status: string;
      created_at: string | Date;
      total: number | string;
      vat_amount?: number | string;
      tax_label?: string;
      cancel_reason?: string;
      courier_name?: string;
      tracking_number?: string;
      tracking_url?: string;
      fulfilment?: 'pickup';
      status_label?: string;
      pickup_point?: {
        name: string;
        address: string | null;
        hours_text: string | null;
        map_url: string | null;
      };
    } = {
      order_id: row.order_id,
      status: row.status,
      created_at: row.created_at,
      total: row.total,
    };

    // Stored tax amount (as charged at order time) + its stored label, when present.
    // Never recomputed here and never uses current CMS rates.
    if (row.vat_amount !== null && row.vat_amount !== undefined) {
      orderPayload.vat_amount = row.vat_amount;
    }
    try {
      const [snapResult] = await pool.query(
        `SELECT tax_label FROM order_tax_snapshots WHERE order_id = ? LIMIT 1`,
        [orderId]
      );
      const snapRows = snapResult as Array<{ tax_label: string | null }>;
      const label = Array.isArray(snapRows) ? snapRows[0]?.tax_label : null;
      if (typeof label === 'string' && label.trim()) {
        orderPayload.tax_label = label.trim();
      }
    } catch {
      /* no snapshot table / row: tracking still works without a label */
    }

    // Courier + tracking (only when present). The link is https-only with {tracking} URL-encoded.
    if (includeShipping) {
      const trackingNumber =
        typeof row.tracking_number === 'string' && row.tracking_number.trim()
          ? row.tracking_number.trim()
          : '';
      if (trackingNumber) orderPayload.tracking_number = trackingNumber;
      if (row.courier_id !== null && row.courier_id !== undefined) {
        try {
          const [courierResult] = await pool.query(
            `SELECT name, tracking_url_template FROM couriers WHERE id = ? LIMIT 1`,
            [row.courier_id]
          );
          const courierRows = courierResult as Array<{
            name: string | null;
            tracking_url_template: string | null;
          }>;
          const courier = Array.isArray(courierRows) ? courierRows[0] : undefined;
          if (courier) {
            if (typeof courier.name === 'string' && courier.name.trim()) {
              orderPayload.courier_name = courier.name.trim();
            }
            const url = trackingNumber
              ? buildTrackingUrl(courier.tracking_url_template, trackingNumber)
              : null;
            if (url) orderPayload.tracking_url = url;
          }
        } catch {
          /* couriers table absent: tracking still works without courier details */
        }
      }
    }

    // Own rider / pickup (BATCH-17). Keys appear only for orders that actually use those paths.
    if (includeOps) {
      const status = String(row.status);
      if (isPickupOrder(row.fulfilment)) {
        orderPayload.fulfilment = 'pickup';
        let address: string | null = null;
        let hours: string | null = null;
        let mapUrl: string | null = null;
        let pointName =
          typeof row.pickup_point_name === 'string' && row.pickup_point_name.trim()
            ? row.pickup_point_name.trim()
            : '';
        if (row.pickup_point_id !== null && row.pickup_point_id !== undefined) {
          try {
            const [pointResult] = await pool.query(
              `SELECT name, address, hours_text, map_url FROM pickup_points WHERE id = ? LIMIT 1`,
              [row.pickup_point_id]
            );
            const p = (pointResult as Array<{
              name: string | null;
              address: string | null;
              hours_text: string | null;
              map_url: string | null;
            }>)[0];
            if (p) {
              address = typeof p.address === 'string' && p.address.trim() ? p.address.trim() : null;
              hours = typeof p.hours_text === 'string' && p.hours_text.trim() ? p.hours_text.trim() : null;
              mapUrl = typeof p.map_url === 'string' && p.map_url.trim() ? p.map_url.trim() : null;
              if (!pointName && typeof p.name === 'string') pointName = p.name.trim();
            }
          } catch {
            /* pickup_points absent: fall back to the stored name snapshot */
          }
        }
        if (pointName) {
          orderPayload.pickup_point = { name: pointName, address, hours_text: hours, map_url: mapUrl };
        }
        if (status === 'ready_for_pickup') {
          orderPayload.status_label = [readyForPickupLabel(pointName), address, hours]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
            .join(', ');
        } else if (status === 'delivered') {
          orderPayload.status_label = deliveredLabel('pickup');
        }
      } else if (status === 'dispatched' && row.rider_id !== null && row.rider_id !== undefined) {
        let riderName: string | null = null;
        try {
          const [riderResult] = await pool.query(`SELECT name FROM riders WHERE id = ? LIMIT 1`, [
            row.rider_id,
          ]);
          const r = (riderResult as Array<{ name: string | null }>)[0];
          riderName = r && typeof r.name === 'string' ? r.name : null;
        } catch {
          riderName = null;
        }
        // First name only; the rider phone number is never selected here.
        orderPayload.status_label = ownRiderTrackingLabel(riderName);
      }
    }

    if (
      includeCancelReason &&
      String(row.status) === 'cancelled' &&
      typeof row.cancel_reason === 'string' &&
      row.cancel_reason.trim()
    ) {
      orderPayload.cancel_reason = row.cancel_reason.trim();
    }

    return res.status(200).json({
      order: orderPayload,
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
