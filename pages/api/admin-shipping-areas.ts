import type { NextApiRequest, NextApiResponse } from 'next';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';
import {
  findDuplicateArea,
  loadShippingAreas,
  resetShippingAreasCache,
  resolveAreaPath,
  wouldCreateParentCycle,
} from '../../lib/shippingAreas';
import { normaliseText } from '../../lib/shippingNormalise';
import type { ShippingArea } from '../../lib/shipping';

/**
 * Shipping areas CRUD (SANDY-BATCH-17). super_admin only (settings:shipping).
 *
 * GET    -> { success, areas } (optional ?city= filter, case/whitespace-insensitive)
 * POST   -> create one area, or { action: 'bulk', city, parent_id, names: string[] }
 * PATCH  -> partial update ({ id, ...fields })
 * DELETE -> refused (409) while sub-areas exist; soft-deactivate when an order.shipping_area snapshot equals this
 *          area's path (or a descendant path); else hard delete.
 *
 * Uniqueness (normalised city + parent + name) is enforced in the API (transaction + FOR UPDATE).
 * Parent must be same city; parent cycles refused. No runtime DDL: missing table => 503.
 */

const NAME_MAX = 120;
const CITY_MAX = 100;
const BULK_MAX = 200;

class ValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
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

function parseId(raw: unknown, label = 'id'): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`Valid ${label} is required`);
  return n;
}

function parseOptionalId(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseId(raw, label);
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Area name is required');
  const t = raw.trim();
  if (!t || t.length > NAME_MAX) throw new ValidationError(`Area name must be 1-${NAME_MAX} characters`);
  if (hasControlChars(t) || /[<>]/.test(t)) throw new ValidationError('Area name contains invalid characters');
  return t;
}

function parseCity(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('City is required');
  const t = raw.trim();
  if (!t || t.length > CITY_MAX) throw new ValidationError(`City must be 1-${CITY_MAX} characters`);
  if (hasControlChars(t) || /[<>]/.test(t)) throw new ValidationError('City contains invalid characters');
  return t;
}

function parseSort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new ValidationError('Invalid sort order');
  return n;
}

function serialise(a: ShippingArea) {
  return {
    id: Number(a.id),
    city: String(a.city ?? ''),
    name: String(a.name ?? ''),
    parent_id: a.parent_id === null || a.parent_id === undefined ? null : Number(a.parent_id),
    zone_id: a.zone_id === null || a.zone_id === undefined ? null : Number(a.zone_id),
    active: Number(a.active) === 1 || a.active === true,
    sort_order: Number(a.sort_order ?? 0),
  };
}

async function assertZoneExists(conn: PoolConnection, zoneId: number | null): Promise<void> {
  if (zoneId === null) return;
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT id FROM shipping_zones WHERE id = ? LIMIT 1',
    [zoneId]
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('Zone not found', 400);
  }
}

async function assertParentOk(
  areas: ShippingArea[],
  city: string,
  parentId: number | null,
  selfId?: number
): Promise<void> {
  if (parentId === null) return;
  const parent = areas.find((a) => Number(a.id) === parentId);
  if (!parent) throw new ValidationError('Parent area not found', 400);
  if (normaliseText(parent.city) !== normaliseText(city)) {
    throw new ValidationError('Parent area must belong to the same city');
  }
  if (selfId !== undefined && wouldCreateParentCycle(areas, selfId, parentId)) {
    throw new ValidationError('Parent would create a cycle');
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * True when an order snapshot equals this area's current path or the path of any descendant
 * ("Parent > Child" snapshots start with the ancestor path). Snapshots are text, so renamed areas are
 * only matched by their current path; a missing orders column counts as referenced (fail safe).
 */
async function areaReferencedByOrders(
  conn: PoolConnection,
  area: ShippingArea,
  areas: ShippingArea[]
): Promise<boolean> {
  const path = resolveAreaPath(areas, area.id);
  if (!path) return false;
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM orders
       WHERE shipping_area IS NOT NULL AND shipping_area <> ''
         AND (shipping_area = ? OR shipping_area LIKE CONCAT(?, ' > %'))`,
      [path, escapeLike(path)]
    );
    return Number((Array.isArray(rows) ? rows[0]?.c : 0) || 0) > 0;
  } catch (err) {
    if (isMissingColumn(err)) return true;
    throw err;
  }
}
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  const session = await requirePermission(req, res, 'settings:shipping');
  if (!session) return;

  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let conn: PoolConnection | null = null;
  try {
    if (method === 'GET') {
      const areas = await loadShippingAreas(pool);
      const cityQ = typeof req.query.city === 'string' ? normaliseText(req.query.city) : '';
      const filtered = cityQ
        ? areas.filter((a) => normaliseText(a.city) === cityQ)
        : areas;
      return res.status(200).json({
        success: true,
        areas: filtered.map(serialise),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Lock area rows so duplicate / cycle checks stay consistent under concurrency.
    await conn.query('SELECT id FROM shipping_areas FOR UPDATE');
    resetShippingAreasCache();
    let areas = await loadShippingAreas(conn);

    if (method === 'POST' && body.action === 'bulk') {
      const city = parseCity(body.city);
      const parentId = parseOptionalId(body.parent_id, 'parent_id');
      await assertParentOk(areas, city, parentId);
      if (!Array.isArray(body.names)) throw new ValidationError('names must be an array');
      const names = body.names
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter(Boolean);
      if (names.length === 0) throw new ValidationError('At least one area name is required');
      if (names.length > BULK_MAX) throw new ValidationError(`At most ${BULK_MAX} names per bulk add`);

      const created: number[] = [];
      const skipped: string[] = [];
      for (const rawName of names) {
        let name: string;
        try {
          name = parseName(rawName);
        } catch {
          skipped.push(String(rawName).slice(0, NAME_MAX));
          continue;
        }
        if (findDuplicateArea(areas, { city, parent_id: parentId, name })) {
          skipped.push(name);
          continue;
        }
        const [result] = await conn.query<ResultSetHeader>(
          `INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
           VALUES (?, ?, ?, NULL, 1, 0)`,
          [city, name, parentId]
        );
        const id = Number(result.insertId);
        created.push(id);
        areas = [
          ...areas,
          {
            id,
            city,
            name,
            parent_id: parentId,
            zone_id: null,
            active: true,
            sort_order: 0,
          },
        ];
      }
      if (created.length > 0) {
        // Audit INSIDE the transaction so a rollback drops the audit row too.
        await recordAudit(conn, {
          actor: session,
          action: 'create',
          entityType: 'shipping_area',
          entityId: null,
          summary: `Bulk-added ${created.length} delivery areas in ${city}`,
          detail: { city, parent_id: parentId, created_ids: created.slice(0, 50), created_count: created.length, skipped_count: skipped.length },
          req,
        });
      }
      await conn.commit();
      resetShippingAreasCache();
      return res.status(200).json({ success: true, created, skipped });
    }

    if (method === 'POST') {
      const city = parseCity(body.city);
      const name = parseName(body.name);
      const parentId = parseOptionalId(body.parent_id, 'parent_id');
      const zoneId = parseOptionalId(body.zone_id, 'zone_id');
      const active = body.active === undefined ? 1 : toFlag(body.active);
      if (active === null) throw new ValidationError('Invalid active flag');
      const sort = parseSort(body.sort_order);

      await assertParentOk(areas, city, parentId);
      await assertZoneExists(conn, zoneId);
      if (findDuplicateArea(areas, { city, parent_id: parentId, name })) {
        throw new ValidationError('An area with this name already exists under that parent', 409);
      }

      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO shipping_areas (city, name, parent_id, zone_id, active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [city, name, parentId, zoneId, active, sort]
      );
      // Audit INSIDE the transaction so a rollback drops the audit row too.
      await recordAudit(conn, {
        actor: session,
        action: 'create',
        entityType: 'shipping_area',
        entityId: Number(result.insertId),
        summary: `Created delivery area "${name}" in ${city}`,
        detail: { city, name, parent_id: parentId, zone_id: zoneId, active, sort_order: sort },
        req,
      });
      await conn.commit();
      resetShippingAreasCache();
      return res.status(200).json({ success: true, id: Number(result.insertId) });
    }

    if (method === 'PATCH') {
      const id = parseId(body.id);
      const existing = areas.find((a) => Number(a.id) === id);
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ error: 'Area not found' });
      }

      const nextCity = body.city !== undefined ? parseCity(body.city) : String(existing.city);
      const nextName = body.name !== undefined ? parseName(body.name) : String(existing.name);
      const nextParent =
        body.parent_id !== undefined
          ? parseOptionalId(body.parent_id, 'parent_id')
          : existing.parent_id === null || existing.parent_id === undefined
            ? null
            : Number(existing.parent_id);
      const nextZone =
        body.zone_id !== undefined
          ? parseOptionalId(body.zone_id, 'zone_id')
          : existing.zone_id === null || existing.zone_id === undefined
            ? null
            : Number(existing.zone_id);

      await assertParentOk(areas, nextCity, nextParent, id);
      await assertZoneExists(conn, nextZone);
      if (findDuplicateArea(areas, { city: nextCity, parent_id: nextParent, name: nextName }, id)) {
        throw new ValidationError('An area with this name already exists under that parent', 409);
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const patch: Record<string, unknown> = {};
      if (body.city !== undefined) {
        sets.push('city = ?');
        params.push(nextCity);
        patch.city = nextCity;
      }
      if (body.name !== undefined) {
        sets.push('name = ?');
        params.push(nextName);
        patch.name = nextName;
      }
      if (body.parent_id !== undefined) {
        sets.push('parent_id = ?');
        params.push(nextParent);
        patch.parent_id = nextParent;
      }
      if (body.zone_id !== undefined) {
        sets.push('zone_id = ?');
        params.push(nextZone);
        patch.zone_id = nextZone;
      }
      if (body.active !== undefined) {
        const f = toFlag(body.active);
        if (f === null) throw new ValidationError('Invalid active flag');
        sets.push('active = ?');
        params.push(f);
        patch.active = f;
      }
      if (body.sort_order !== undefined) {
        sets.push('sort_order = ?');
        params.push(parseSort(body.sort_order));
        patch.sort_order = params[params.length - 1];
      }
      if (!sets.length) {
        await conn.rollback();
        return res.status(400).json({ error: 'Nothing to update' });
      }

      await conn.query(`UPDATE shipping_areas SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      // Audit INSIDE the transaction so a rollback drops the audit row too.
      const areaBefore = serialise(existing) as Record<string, unknown>;
      const areaBeforeSlice: Record<string, unknown> = {};
      for (const k of Object.keys(patch)) {
        areaBeforeSlice[k] = k === 'active' ? (areaBefore.active ? 1 : 0) : areaBefore[k];
      }
      await recordAudit(conn, {
        actor: session,
        action: 'update',
        entityType: 'shipping_area',
        entityId: id,
        summary: `Updated delivery area "${String(existing.name ?? id)}"`,
        detail: { changes: auditFieldDiff(areaBeforeSlice, patch) },
        req,
      });
      await conn.commit();
      resetShippingAreasCache();
      return res.status(200).json({ success: true });
    }

    // DELETE
    const id = parseId(body.id ?? req.query.id);
    const existing = areas.find((a) => Number(a.id) === id);
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ error: 'Area not found' });
    }

    if (areas.some((a) => a.parent_id !== null && Number(a.parent_id) === id)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Remove or move the sub-areas first' });
    }

    const inUse = await areaReferencedByOrders(conn, existing, areas);
    if (inUse) {
      await conn.query('UPDATE shipping_areas SET active = 0 WHERE id = ?', [id]);
      await recordAudit(conn, {
        actor: session,
        action: 'status_change',
        entityType: 'shipping_area',
        entityId: id,
        summary: `Deactivated delivery area "${String(existing.name ?? id)}" (in use by orders)`,
        detail: { name: existing.name, city: existing.city, changes: { active: { from: serialise(existing).active ? 1 : 0, to: 0 } }, deleted: false },
        req,
      });
      await conn.commit();
      resetShippingAreasCache();
      return res.status(200).json({ success: true, deactivated: true, deleted: false });
    }
    await conn.query('DELETE FROM shipping_areas WHERE id = ?', [id]);
    await recordAudit(conn, {
      actor: session,
      action: 'delete',
      entityType: 'shipping_area',
      entityId: id,
      summary: `Deleted delivery area "${String(existing.name ?? id)}"`,
      detail: { name: existing.name, city: existing.city },
      req,
    });
    await conn.commit();
    resetShippingAreasCache();
    return res.status(200).json({ success: true, deactivated: false, deleted: true });
  } catch (error: unknown) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
    }
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isMissingTable(error) || isMissingColumn(error)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    console.error('[admin-shipping-areas] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (conn) conn.release();
  }
}
