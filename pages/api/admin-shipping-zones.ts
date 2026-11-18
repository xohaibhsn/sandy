import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';
import { loadShippingSettings } from '../../lib/shippingSettings';
import { resetShippingZonesCache } from '../../lib/shipping';
import { normaliseCity } from '../../lib/shippingNormalise';
import {
  findZoneListOverlap,
  formatOverlapError,
  type OverlapZoneInput,
} from '../../lib/shippingZoneOverlap';

/**
 * Shipping zones CRUD (SANDY-BATCH-12). super_admin only (settings:shipping), every method.
 *
 * GET    -> { success, zones }
 * POST   -> create a zone
 * PATCH  -> partial update ({ id, ...fields })
 * DELETE -> { id } (body or ?id=): a zone referenced by orders is only DEACTIVATED (active = 0);
 *           an unreferenced zone is deleted.
 *
 * Rules enforced on every write: name 1-120; rate >= 0; free_min null or >= 0; at most ONE active
 * default zone; while shipping_enabled = 1 the single active default zone can not be removed,
 * deactivated or un-defaulted (the flag would otherwise be left on with no fallback zone).
 * BATCH-14: an active zone may not share a city/province (case/whitespace-insensitive) with
 * another active zone; inactive zones do not block; empty default lists are exempt. The check
 * and write share one transaction (FOR UPDATE on active rows) so concurrent saves cannot both
 * succeed. Overlaps are write-only — GET/list never rejects pre-existing data.
 * No runtime DDL: a missing table answers 503 { error: "Service unavailable" }.
 */

const NAME_MAX = 120;
const ESTIMATE_MAX = 120;
const LIST_ENTRY_MAX = 100;
const LIST_TOTAL_MAX = 20_000;
const MONEY_MAX = 99_999_999.99;

class ValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

function noStore(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
}

function isMissingTable(err: unknown): boolean {
  const e = err as { errno?: number; code?: string } | null;
  return !!e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');
}

function isMissingColumn(err: unknown): boolean {
  const e = err as { errno?: number; code?: string } | null;
  return !!e && (e.errno === 1054 || e.code === 'ER_BAD_FIELD_ERROR');
}

function toFlag(v: unknown): 0 | 1 | null {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return null;
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Zone name is required');
  const t = raw.trim();
  if (!t || t.length > NAME_MAX) throw new ValidationError(`Zone name must be 1-${NAME_MAX} characters`);
  if (hasControlChars(t) || /[<>]/.test(t)) throw new ValidationError('Zone name contains invalid characters');
  return t;
}

/** Money with at most 2 decimals, 0..MONEY_MAX. */
function parseMoney(raw: unknown, label: string): number {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim())) n = Number(raw.trim());
  else throw new ValidationError(`${label} must be a number of 0 or greater`);
  if (!Number.isFinite(n) || n < 0 || n > MONEY_MAX) {
    throw new ValidationError(`${label} must be a number of 0 or greater`);
  }
  if (Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) {
    throw new ValidationError(`${label} can have at most 2 decimal places`);
  }
  return Math.round(n * 100) / 100;
}

function parseFreeMin(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseMoney(raw, 'Free-shipping minimum');
}

/** City / province list: array or newline|comma|semicolon text -> trimmed, de-duplicated, "\n"-joined (or null). */
function parseList(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parts: unknown[];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(/[\r\n,;|]+/);
  else throw new ValidationError(`${label} must be text`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (typeof p !== 'string') throw new ValidationError(`${label} must be text`);
    const t = p.trim();
    if (!t) continue;
    if (t.length > LIST_ENTRY_MAX || hasControlChars(t) || /[<>]/.test(t)) {
      throw new ValidationError(`${label} contains an invalid entry`);
    }
    const key = normaliseCity(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (!out.length) return null;
  const joined = out.join('\n');
  if (joined.length > LIST_TOTAL_MAX) throw new ValidationError(`${label} is too long`);
  return joined;
}

function parseEstimate(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('Delivery estimate must be text');
  const t = raw.trim();
  if (!t) return null;
  if (t.length > ESTIMATE_MAX || hasControlChars(t) || /[<>]/.test(t)) {
    throw new ValidationError(`Delivery estimate must be at most ${ESTIMATE_MAX} characters`);
  }
  return t;
}

function parseSort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new ValidationError('Invalid sort order');
  return n;
}

function parseId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Valid zone id is required');
  return n;
}

type ZoneRow = RowDataPacket & {
  id: number;
  name: string;
  cities: string | null;
  provinces: string | null;
  is_default: number;
  rate: string | number;
  free_min: string | number | null;
  estimate_text: string | null;
  active: number;
  sort_order: number;
};

function serialise(row: ZoneRow) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    cities: row.cities ?? '',
    provinces: row.provinces ?? '',
    is_default: Number(row.is_default) === 1,
    rate: Number(row.rate),
    free_min: row.free_min === null || row.free_min === undefined ? null : Number(row.free_min),
    estimate_text: row.estimate_text ?? '',
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order ?? 0),
  };
}

const ZONE_COLUMNS =
  'id, name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order';

function asOverlapZones(rows: ZoneRow[]): OverlapZoneInput[] {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    cities: row.cities,
    provinces: row.provinces,
    active: Number(row.active) === 1 ? 1 : 0,
    is_default: Number(row.is_default) === 1 ? 1 : 0,
  }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  noStore(res);

  const session = await requirePermission(req, res, 'settings:shipping');
  if (!session) return;

  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (method === 'GET') {
      const [rows] = await pool.query<ZoneRow[]>(
        `SELECT ${ZONE_COLUMNS} FROM shipping_zones ORDER BY sort_order ASC, id ASC`
      );
      return res.status(200).json({
        success: true,
        zones: (Array.isArray(rows) ? rows : []).map(serialise),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    if (method === 'POST') {
      const name = parseName(body.name);
      const cities = parseList(body.cities, 'Cities');
      const provinces = parseList(body.provinces, 'Provinces');
      const rate = body.rate === undefined || body.rate === '' ? 0 : parseMoney(body.rate, 'Rate');
      const freeMin = parseFreeMin(body.free_min);
      const estimate = parseEstimate(body.estimate_text);
      const active = body.active === undefined ? 1 : toFlag(body.active);
      const isDefault = body.is_default === undefined ? 0 : toFlag(body.is_default);
      if (active === null || isDefault === null) throw new ValidationError('Invalid flag');
      const sort = parseSort(body.sort_order);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock every active zone (and all rows so a concurrent insert cannot sneak past).
        const [lockedRows] = await conn.query<ZoneRow[]>(
          `SELECT ${ZONE_COLUMNS} FROM shipping_zones ORDER BY id ASC FOR UPDATE`
        );
        if (active === 1 && isDefault === 1) {
          const defs = (Array.isArray(lockedRows) ? lockedRows : []).filter(
            (z) => Number(z.active) === 1 && Number(z.is_default) === 1
          );
          if (defs.length > 0) {
            await conn.rollback();
            return res.status(409).json({
              error: 'An active default zone already exists. Unset it before creating another.',
            });
          }
        }
        if (active === 1) {
          const conflict = findZoneListOverlap({
            cities,
            provinces,
            excludeZoneId: null,
            otherZones: asOverlapZones(lockedRows),
          });
          if (conflict) {
            await conn.rollback();
            return res.status(409).json({ error: formatOverlapError(conflict) });
          }
        }
        const [result] = await conn.query<ResultSetHeader>(
          `INSERT INTO shipping_zones
             (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, cities, provinces, isDefault, rate, freeMin, estimate, active, sort]
        );
        await conn.commit();
        resetShippingZonesCache();
        return res.status(200).json({ success: true, id: Number(result.insertId) });
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        conn.release();
      }
    }

    if (method === 'PATCH') {
      const id = parseId(body.id);
      // Loaded BEFORE taking a transaction connection (tiny pool; avoid a second checkout while holding one).
      const shippingEnabled = (await loadShippingSettings()).shipping_enabled;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [lockedRows] = await conn.query<ZoneRow[]>(
          `SELECT ${ZONE_COLUMNS} FROM shipping_zones ORDER BY id ASC FOR UPDATE`
        );
        const existing = (Array.isArray(lockedRows) ? lockedRows : []).find(
          (z) => Number(z.id) === id
        );
        if (!existing) {
          await conn.rollback();
          return res.status(404).json({ error: 'Zone not found' });
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        let nextActive = Number(existing.active) === 1 ? 1 : 0;
        let nextDefault = Number(existing.is_default) === 1 ? 1 : 0;
        let nextCities: string | null = existing.cities;
        let nextProvinces: string | null = existing.provinces;

        if (body.name !== undefined) {
          sets.push('name = ?');
          params.push(parseName(body.name));
        }
        if (body.cities !== undefined) {
          nextCities = parseList(body.cities, 'Cities');
          sets.push('cities = ?');
          params.push(nextCities);
        }
        if (body.provinces !== undefined) {
          nextProvinces = parseList(body.provinces, 'Provinces');
          sets.push('provinces = ?');
          params.push(nextProvinces);
        }
        if (body.rate !== undefined) {
          sets.push('rate = ?');
          params.push(parseMoney(body.rate, 'Rate'));
        }
        if (body.free_min !== undefined) {
          sets.push('free_min = ?');
          params.push(parseFreeMin(body.free_min));
        }
        if (body.estimate_text !== undefined) {
          sets.push('estimate_text = ?');
          params.push(parseEstimate(body.estimate_text));
        }
        if (body.sort_order !== undefined) {
          sets.push('sort_order = ?');
          params.push(parseSort(body.sort_order));
        }
        if (body.active !== undefined) {
          const f = toFlag(body.active);
          if (f === null) throw new ValidationError('Invalid active flag');
          nextActive = f;
          sets.push('active = ?');
          params.push(f);
        }
        if (body.is_default !== undefined) {
          const f = toFlag(body.is_default);
          if (f === null) throw new ValidationError('Invalid default flag');
          nextDefault = f;
          sets.push('is_default = ?');
          params.push(f);
        }
        if (!sets.length) {
          await conn.rollback();
          return res.status(400).json({ error: 'Nothing to update' });
        }

        const wasActiveDefault = Number(existing.active) === 1 && Number(existing.is_default) === 1;
        const willBeActiveDefault = nextActive === 1 && nextDefault === 1;

        if (willBeActiveDefault && !wasActiveDefault) {
          const defs = (Array.isArray(lockedRows) ? lockedRows : []).filter(
            (z) =>
              Number(z.id) !== id && Number(z.active) === 1 && Number(z.is_default) === 1
          );
          if (defs.length > 0) {
            await conn.rollback();
            return res.status(409).json({
              error: 'An active default zone already exists. Unset it before choosing another.',
            });
          }
        }

        if (wasActiveDefault && !willBeActiveDefault && shippingEnabled) {
          await conn.rollback();
          return res.status(409).json({
            error: 'Shipping is enabled: turn it off before removing the active default zone.',
          });
        }

        if (nextActive === 1) {
          const conflict = findZoneListOverlap({
            cities: nextCities,
            provinces: nextProvinces,
            excludeZoneId: id,
            otherZones: asOverlapZones(lockedRows),
          });
          if (conflict) {
            await conn.rollback();
            return res.status(409).json({ error: formatOverlapError(conflict) });
          }
        }

        await conn.query(`UPDATE shipping_zones SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        await conn.commit();
        resetShippingZonesCache();
        return res.status(200).json({ success: true });
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        conn.release();
      }
    }

    // DELETE
    const id = parseId(body.id ?? req.query.id);
    const shippingEnabled = (await loadShippingSettings()).shipping_enabled;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existingRows] = await conn.query<ZoneRow[]>(
        `SELECT ${ZONE_COLUMNS} FROM shipping_zones WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id]
      );
      const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ error: 'Zone not found' });
      }

      if (
        Number(existing.active) === 1 &&
        Number(existing.is_default) === 1 &&
        shippingEnabled
      ) {
        await conn.rollback();
        return res.status(409).json({
          error: 'Shipping is enabled: turn it off before removing the active default zone.',
        });
      }

      let inUse = false;
      try {
        const [used] = await conn.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS c FROM orders WHERE shipping_zone = ?',
          [String(existing.name)]
        );
        inUse = Number((Array.isArray(used) ? used[0]?.c : 0) || 0) > 0;
      } catch (err) {
        // orders.shipping_zone missing (migration 0009 partly applied): treat as in use, never hard delete.
        if (!isMissingColumn(err)) throw err;
        inUse = true;
      }

      if (inUse) {
        await conn.query('UPDATE shipping_zones SET active = 0 WHERE id = ?', [id]);
        await conn.commit();
        resetShippingZonesCache();
        return res.status(200).json({ success: true, deactivated: true, deleted: false });
      }

      await conn.query('DELETE FROM shipping_zones WHERE id = ?', [id]);
      await conn.commit();
      resetShippingZonesCache();
      return res.status(200).json({ success: true, deactivated: false, deleted: true });
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      conn.release();
    }
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isMissingTable(error) || isMissingColumn(error)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    console.error('[admin-shipping-zones] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
