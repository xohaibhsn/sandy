import type { NextApiRequest, NextApiResponse } from 'next';
import type { RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import { loadShippingSettings } from '../../lib/shippingSettings';
import { hasDeliveryOpsSchema } from '../../lib/shippingSchema';
import { loadShippingAreas } from '../../lib/shippingAreas';
import { normaliseText } from '../../lib/shippingNormalise';

/**
 * Public, read-only checkout locations (SANDY-BATCH-17).
 *
 * GET /api/shipping-locations[?city=Lahore]
 *   - shipping off, or both delivery-ops flags off => { areas_enabled: false, pickup_enabled: false }
 *     (stable minimal keys, no database reads beyond the flag cache).
 *   - areas on  => areas: ACTIVE areas only ({ id, city, name, parent_id }), optional ?city= filter.
 *   - pickup on => pickup_points: ACTIVE points only ({ id, name, city, address, hours_text, map_url }).
 * Never exposes zone ids, rates, inactive rows or any admin data. Migration 0010 missing while a flag
 * is on => 503 { error: "Service unavailable" }.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = RL_GENERAL(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    const settings = await loadShippingSettings();
    const areasOn = settings.shipping_enabled && settings.shipping_areas_enabled;
    const pickupOn = settings.shipping_enabled && settings.pickup_enabled;
    if (!areasOn && !pickupOn) {
      return res.status(200).json({ areas_enabled: false, pickup_enabled: false });
    }

    if (!(await hasDeliveryOpsSchema(pool))) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    const cityRaw = req.query.city;
    if (cityRaw !== undefined && (typeof cityRaw !== 'string' || cityRaw.length > 100)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const cityFilter = typeof cityRaw === 'string' ? normaliseText(cityRaw) : '';

    const payload: Record<string, unknown> = {
      areas_enabled: areasOn,
      pickup_enabled: pickupOn,
    };

    if (areasOn) {
      const areas = await loadShippingAreas(pool);
      payload.areas = areas
        .filter((a) => Number(a.active) === 1 || a.active === true)
        .filter((a) => !cityFilter || normaliseText(a.city) === cityFilter)
        .map((a) => ({
          id: Number(a.id),
          city: String(a.city),
          name: String(a.name),
          parent_id: a.parent_id === null || a.parent_id === undefined ? null : Number(a.parent_id),
        }));
    }

    if (pickupOn) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, name, city, address, hours_text, map_url
         FROM pickup_points WHERE active = 1 ORDER BY sort_order ASC, id ASC`
      );
      payload.pickup_points = (Array.isArray(rows) ? rows : [])
        .filter((p) => !cityFilter || normaliseText(p.city) === cityFilter)
        .map((p) => ({
          id: Number(p.id),
          name: String(p.name ?? ''),
          city: String(p.city ?? ''),
          address: String(p.address ?? ''),
          hours_text: p.hours_text == null ? null : String(p.hours_text),
          map_url: p.map_url == null ? null : String(p.map_url),
        }));
    }

    return res.status(200).json(payload);
  } catch (error: unknown) {
    console.error('[shipping-locations] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(503).json({ error: 'Service unavailable' });
  }
}
