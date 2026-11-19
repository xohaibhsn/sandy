import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';

/**
 * Pickup points CRUD (SANDY-BATCH-17 self-pickup). super_admin only (settings:shipping).
 *
 * GET / POST / PATCH / DELETE. map_url optional https only.
 * DELETE soft-deactivates when orders.pickup_point_id references the point; else hard deletes.
 * Missing table/column => 503. No runtime DDL.
 */

const NAME_MAX = 120;
const CITY_MAX = 100;
const ADDRESS_MAX = 300;
const HOURS_MAX = 120;
const MAP_URL_MAX = 500;

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

function parseId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Valid pickup point id is required');
  return n;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Pickup point name is required');
  const t = raw.trim();
  if (!t || t.length > NAME_MAX) throw new ValidationError(`Name must be 1-${NAME_MAX} characters`);
  if (hasControlChars(t) || /[<>]/.test(t)) throw new ValidationError('Name contains invalid characters');
  return t;
}

function parseCity(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('City is required');
  const t = raw.trim();
  if (!t || t.length > CITY_MAX) throw new ValidationError(`City must be 1-${CITY_MAX} characters`);
  if (hasControlChars(t) || /[<>]/.test(t)) throw new ValidationError('City contains invalid characters');
  return t;
}

function parseAddress(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Address is required');
  const t = raw.trim();
  if (!t || t.length > ADDRESS_MAX) {
    throw new ValidationError(`Address must be 1-${ADDRESS_MAX} characters`);
  }
  if (hasControlChars(t)) throw new ValidationError('Address contains invalid characters');
  return t;
}

function parseHours(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('Hours must be text');
  const t = raw.trim();
  if (!t) return null;
  if (t.length > HOURS_MAX) throw new ValidationError(`Hours must be at most ${HOURS_MAX} characters`);
  if (hasControlChars(t)) throw new ValidationError('Hours contains invalid characters');
  return t;
}

function parseMapUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('Map link must be text');
  const t = raw.trim();
  if (!t) return null;
  if (t.length > MAP_URL_MAX) throw new ValidationError(`Map link must be at most ${MAP_URL_MAX} characters`);
  let parsed: URL;
  try {
    parsed = new URL(t);
  } catch {
    throw new ValidationError('Map link must be a valid https URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new ValidationError('Map link must be a valid https URL');
  }
  return t;
}

function parseSort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new ValidationError('Invalid sort order');
  return n;
}

type PointRow = RowDataPacket & {
  id: number;
  name: string;
  city: string;
  address: string;
  hours_text: string | null;
  map_url: string | null;
  active: number;
  sort_order: number;
};

function serialise(row: PointRow) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    city: String(row.city ?? ''),
    address: String(row.address ?? ''),
    hours_text: row.hours_text ?? '',
    map_url: row.map_url ?? '',
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order ?? 0),
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  const session = await requirePermission(req, res, 'settings:shipping');
  if (!session) return;

  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (method === 'GET') {
      const [rows] = await pool.query<PointRow[]>(
        `SELECT id, name, city, address, hours_text, map_url, active, sort_order
         FROM pickup_points ORDER BY sort_order ASC, id ASC`
      );
      return res.status(200).json({
        success: true,
        pickup_points: (Array.isArray(rows) ? rows : []).map(serialise),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    if (method === 'POST') {
      const name = parseName(body.name);
      const city = parseCity(body.city);
      const address = parseAddress(body.address);
      const hours = parseHours(body.hours_text);
      const mapUrl = parseMapUrl(body.map_url);
      const active = body.active === undefined ? 1 : toFlag(body.active);
      if (active === null) throw new ValidationError('Invalid active flag');
      const sort = parseSort(body.sort_order);
      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO pickup_points (name, city, address, hours_text, map_url, active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, city, address, hours, mapUrl, active, sort]
      );
      return res.status(200).json({ success: true, id: Number(result.insertId) });
    }

    if (method === 'PATCH') {
      const id = parseId(body.id);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        sets.push('name = ?');
        params.push(parseName(body.name));
      }
      if (body.city !== undefined) {
        sets.push('city = ?');
        params.push(parseCity(body.city));
      }
      if (body.address !== undefined) {
        sets.push('address = ?');
        params.push(parseAddress(body.address));
      }
      if (body.hours_text !== undefined) {
        sets.push('hours_text = ?');
        params.push(parseHours(body.hours_text));
      }
      if (body.map_url !== undefined) {
        sets.push('map_url = ?');
        params.push(parseMapUrl(body.map_url));
      }
      if (body.active !== undefined) {
        const f = toFlag(body.active);
        if (f === null) throw new ValidationError('Invalid active flag');
        sets.push('active = ?');
        params.push(f);
      }
      if (body.sort_order !== undefined) {
        sets.push('sort_order = ?');
        params.push(parseSort(body.sort_order));
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

      const [exists] = await pool.query<RowDataPacket[]>(
        'SELECT id FROM pickup_points WHERE id = ? LIMIT 1',
        [id]
      );
      if (!Array.isArray(exists) || exists.length === 0) {
        return res.status(404).json({ error: 'Pickup point not found' });
      }
      await pool.query(`UPDATE pickup_points SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      return res.status(200).json({ success: true });
    }

    const id = parseId(body.id ?? req.query.id);
    const [exists] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM pickup_points WHERE id = ? LIMIT 1',
      [id]
    );
    if (!Array.isArray(exists) || exists.length === 0) {
      return res.status(404).json({ error: 'Pickup point not found' });
    }

    let inUse = false;
    try {
      const [used] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM orders WHERE pickup_point_id = ?',
        [id]
      );
      inUse = Number((Array.isArray(used) ? used[0]?.c : 0) || 0) > 0;
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
      inUse = true;
    }

    if (inUse) {
      await pool.query('UPDATE pickup_points SET active = 0 WHERE id = ?', [id]);
      return res.status(200).json({ success: true, deactivated: true, deleted: false });
    }
    await pool.query('DELETE FROM pickup_points WHERE id = ?', [id]);
    return res.status(200).json({ success: true, deactivated: false, deleted: true });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isMissingTable(error) || isMissingColumn(error)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    console.error('[admin-pickup-points] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
