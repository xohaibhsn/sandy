import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';
import { loadShippingSettings } from '../../lib/shippingSettings';
import { resetShippingZonesCache } from '../../lib/shipping';
import { hasDeliveryOpsZoneColumns } from '../../lib/shippingSchema';
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
  delivery_method?: string | null;
  same_day_cutoff?: string | null;
};

const CUTOFF_RE = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/;

function parseDeliveryMethod(raw: unknown): 'courier' | 'own_rider' {
  if (raw === undefined || raw === null || raw === '') return 'courier';
  const s = String(raw).trim().toLowerCase();
  if (s === 'courier' || s === 'own_rider') return s;
  throw new ValidationError("Delivery method must be 'courier' or 'own_rider'");
}

/** null/'' => NULL. Otherwise HH:MM or HH:MM:SS stored as MySQL TIME. */
function parseSameDayCutoff(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ValidationError('Same-day cut-off must be HH:MM');
  }
  const t = String(raw).trim();
  const m = CUTOFF_RE.exec(t);
  if (!m) throw new ValidationError('Same-day cut-off must be HH:MM');
  const h = Number(m[1]);
  if (h < 0 || h > 23) throw new ValidationError('Same-day cut-off must be HH:MM');
  return `${String(h).padStart(2, '0')}:${m[2]}:00`;
}

function serialise(row: ZoneRow, includeOps: boolean) {
  const base = {
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
  if (!includeOps) return base;
  const method = String(row.delivery_method ?? 'courier').trim().toLowerCase();
  return {
    ...base,
    delivery_method: method === 'own_rider' ? 'own_rider' : 'courier',
    same_day_cutoff:
      row.same_day_cutoff === null || row.same_day_cutoff === undefined
        ? null
        : String(row.same_day_cutoff).slice(0, 8),
  };
}

const ZONE_COLUMNS =
  'id, name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order';
const ZONE_COLUMNS_OPS = `${ZONE_COLUMNS}, delivery_method, same_day_cutoff`;

/** Normalised "before" values (same shapes the PATCH handler writes) for the audit diff. */
function serialiseForAudit(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: row.name,
    cities: row.cities ?? null,
    provinces: row.provinces ?? null,
    rate: Number(row.rate),
    free_min: row.free_min === null || row.free_min === undefined ? null : Number(row.free_min),
    estimate_text: row.estimate_text ?? null,
    sort_order: Number(row.sort_order ?? 0),
    active: Number(row.active) === 1 ? 1 : 0,
    is_default: Number(row.is_default) === 1 ? 1 : 0,
    delivery_method: row.delivery_method === undefined ? undefined : String(row.delivery_method ?? 'courier').trim().toLowerCase(),
    same_day_cutoff:
      row.same_day_cutoff === undefined || row.same_day_cutoff === null
        ? null
        : String(row.same_day_cutoff).slice(0, 8),
  };
}

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
    const opsCols = await hasDeliveryOpsZoneColumns(pool);
    const zoneCols = opsCols ? ZONE_COLUMNS_OPS : ZONE_COLUMNS;

    if (method === 'GET') {
      const [rows] = await pool.query<ZoneRow[]>(
        `SELECT ${zoneCols} FROM shipping_zones ORDER BY sort_order ASC, id ASC`
      );
      return res.status(200).json({
        success: true,
        zones: (Array.isArray(rows) ? rows : []).map((r) => serialise(r, opsCols)),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    // Migration 0010 missing: a write that carries the new fields cannot be honoured => 503 (never ignored).
    if (
      !opsCols &&
      (method === 'POST' || method === 'PATCH') &&
      (body.delivery_method !== undefined || body.same_day_cutoff !== undefined)
    ) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

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
      const deliveryMethod = opsCols ? parseDeliveryMethod(body.delivery_method) : null;
      const cutoff = opsCols ? parseSameDayCutoff(body.same_day_cutoff) : null;

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock every active zone (and all rows so a concurrent insert cannot sneak past).
        const [lockedRows] = await conn.query<ZoneRow[]>(
          `SELECT ${zoneCols} FROM shipping_zones ORDER BY id ASC FOR UPDATE`
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
        const [result] = opsCols
          ? await conn.query<ResultSetHeader>(
              `INSERT INTO shipping_zones
                 (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order,
                  delivery_method, same_day_cutoff)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                name,
                cities,
                provinces,
                isDefault,
                rate,
                freeMin,
                estimate,
                active,
                sort,
                deliveryMethod,
                cutoff,
              ]
            )
          : await conn.query<ResultSetHeader>(
              `INSERT INTO shipping_zones
                 (name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [name, cities, provinces, isDefault, rate, freeMin, estimate, active, sort]
            );
        // Audit INSIDE the transaction so a rollback drops the audit row too.
        await recordAudit(conn, {
          actor: session,
          action: 'create',
          entityType: 'shipping_zone',
          entityId: Number(result.insertId),
          summary: `Created shipping zone "${name}"`,
          detail: {
            name,
            cities,
            provinces,
            is_default: isDefault,
            rate,
            free_min: freeMin,
            estimate_text: estimate,
            active,
            sort_order: sort,
            delivery_method: deliveryMethod,
            same_day_cutoff: cutoff,
          },
          req,
        });
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
          `SELECT ${zoneCols} FROM shipping_zones ORDER BY id ASC FOR UPDATE`
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
        const patch: Record<string, unknown> = {};
        let nextActive = Number(existing.active) === 1 ? 1 : 0;
        let nextDefault = Number(existing.is_default) === 1 ? 1 : 0;
        let nextCities: string | null = existing.cities;
        let nextProvinces: string | null = existing.provinces;

        if (body.name !== undefined) {
          sets.push('name = ?');
          params.push(parseName(body.name));
          patch.name = params[params.length - 1];
        }
        if (body.cities !== undefined) {
          nextCities = parseList(body.cities, 'Cities');
          sets.push('cities = ?');
          params.push(nextCities);
          patch.cities = nextCities;
        }
        if (body.provinces !== undefined) {
          nextProvinces = parseList(body.provinces, 'Provinces');
          sets.push('provinces = ?');
          params.push(nextProvinces);
          patch.provinces = nextProvinces;
        }
        if (body.rate !== undefined) {
          sets.push('rate = ?');
          params.push(parseMoney(body.rate, 'Rate'));
          patch.rate = params[params.length - 1];
        }
        if (body.free_min !== undefined) {
          sets.push('free_min = ?');
          params.push(parseFreeMin(body.free_min));
          patch.free_min = params[params.length - 1];
        }
        if (body.estimate_text !== undefined) {
          sets.push('estimate_text = ?');
          params.push(parseEstimate(body.estimate_text));
          patch.estimate_text = params[params.length - 1];
        }
        if (body.sort_order !== undefined) {
          sets.push('sort_order = ?');
          params.push(parseSort(body.sort_order));
          patch.sort_order = params[params.length - 1];
        }
        if (body.active !== undefined) {
          const f = toFlag(body.active);
          if (f === null) throw new ValidationError('Invalid active flag');
          nextActive = f;
          sets.push('active = ?');
          params.push(f);
          patch.active = f;
        }
        if (body.is_default !== undefined) {
          const f = toFlag(body.is_default);
          if (f === null) throw new ValidationError('Invalid default flag');
          nextDefault = f;
          sets.push('is_default = ?');
          params.push(f);
          patch.is_default = f;
        }
        if (opsCols && body.delivery_method !== undefined) {
          sets.push('delivery_method = ?');
          params.push(parseDeliveryMethod(body.delivery_method));
          patch.delivery_method = params[params.length - 1];
        }
        if (opsCols && body.same_day_cutoff !== undefined) {
          sets.push('same_day_cutoff = ?');
          params.push(parseSameDayCutoff(body.same_day_cutoff));
          patch.same_day_cutoff = params[params.length - 1];
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
        // Audit INSIDE the transaction so a rollback drops the audit row too.
        const zoneBefore = serialiseForAudit(existing as unknown as Record<string, unknown>);
        const zoneBeforeSlice: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) zoneBeforeSlice[k] = zoneBefore[k];
        await recordAudit(conn, {
          actor: session,
          action: 'update',
          entityType: 'shipping_zone',
          entityId: id,
          summary: `Updated shipping zone "${String(existing.name ?? id)}"`,
          detail: { changes: auditFieldDiff(zoneBeforeSlice, patch) },
          req,
        });
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

      // SANDY-BATCH-17: a zone pinned by a delivery area is soft-deactivated, never hard deleted.
      if (!inUse && opsCols) {
        try {
          const [pinned] = await conn.query<RowDataPacket[]>(
            'SELECT COUNT(*) AS c FROM shipping_areas WHERE zone_id = ?',
            [id]
          );
          inUse = Number((Array.isArray(pinned) ? pinned[0]?.c : 0) || 0) > 0;
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      }

      if (inUse) {
        await conn.query('UPDATE shipping_zones SET active = 0 WHERE id = ?', [id]);
        await recordAudit(conn, {
          actor: session,
          action: 'status_change',
          entityType: 'shipping_zone',
          entityId: id,
          summary: `Deactivated shipping zone "${String(existing.name ?? id)}" (in use)`,
          detail: { name: existing.name, changes: { active: { from: Number(existing.active), to: 0 } }, deleted: false },
          req,
        });
        await conn.commit();
        resetShippingZonesCache();
        return res.status(200).json({ success: true, deactivated: true, deleted: false });
      }

      await conn.query('DELETE FROM shipping_zones WHERE id = ?', [id]);
      await recordAudit(conn, {
        actor: session,
        action: 'delete',
        entityType: 'shipping_zone',
        entityId: id,
        summary: `Deleted shipping zone "${String(existing.name ?? id)}"`,
        detail: { name: existing.name, is_default: Number(existing.is_default), active: Number(existing.active) },
        req,
      });
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
