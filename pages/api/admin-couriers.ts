import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';

/**
 * Couriers CRUD (SANDY-BATCH-12, manual courier flow). super_admin only (settings:shipping).
 *
 * GET    -> { success, couriers }
 * POST   -> create
 * PATCH  -> partial update ({ id, ...fields })
 * DELETE -> { id } (body or ?id=): a courier referenced by orders is only DEACTIVATED (active = 0);
 *           an unreferenced courier is deleted.
 *
 * tracking_url_template is optional. When set it must contain {tracking} and be an https URL
 * (checked after substituting a sample value). No runtime DDL: a missing table answers 503.
 */

const NAME_MAX = 100;
const TEMPLATE_MAX = 500;
const TRACKING_TOKEN = '{tracking}';

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

function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Courier name is required');
  const t = raw.trim();
  if (!t || t.length > NAME_MAX) throw new ValidationError(`Courier name must be 1-${NAME_MAX} characters`);
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) throw new ValidationError('Courier name contains invalid characters');
  }
  if (/[<>]/.test(t)) throw new ValidationError('Courier name contains invalid characters');
  return t;
}

/** null/'' => NULL. Otherwise: <=500 chars, no whitespace/controls, contains {tracking}, https URL. */
function parseTemplate(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('Tracking link must be text');
  const t = raw.trim();
  if (!t) return null;
  if (t.length > TEMPLATE_MAX) {
    throw new ValidationError(`Tracking link must be at most ${TEMPLATE_MAX} characters`);
  }
  if (hasControlOrSpace(t)) throw new ValidationError('Tracking link must not contain spaces');
  if (!t.includes(TRACKING_TOKEN)) {
    throw new ValidationError('Tracking link must contain {tracking}');
  }
  let parsed: URL;
  try {
    parsed = new URL(t.split(TRACKING_TOKEN).join('TRACK123'));
  } catch {
    throw new ValidationError('Tracking link must be a valid https URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || /[{}]/.test(parsed.hostname)) {
    throw new ValidationError('Tracking link must be a valid https URL');
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
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Valid courier id is required');
  return n;
}

type CourierRow = RowDataPacket & {
  id: number;
  name: string;
  tracking_url_template: string | null;
  active: number;
  sort_order: number;
};

function serialise(row: CourierRow) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    tracking_url_template: row.tracking_url_template ?? '',
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
      const [rows] = await pool.query<CourierRow[]>(
        'SELECT id, name, tracking_url_template, active, sort_order FROM couriers ORDER BY sort_order ASC, id ASC'
      );
      return res.status(200).json({
        success: true,
        couriers: (Array.isArray(rows) ? rows : []).map(serialise),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    if (method === 'POST') {
      const name = parseName(body.name);
      const template = parseTemplate(body.tracking_url_template);
      const active = body.active === undefined ? 1 : toFlag(body.active);
      if (active === null) throw new ValidationError('Invalid active flag');
      const sort = parseSort(body.sort_order);
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO couriers (name, tracking_url_template, active, sort_order) VALUES (?, ?, ?, ?)',
        [name, template, active, sort]
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
      if (body.tracking_url_template !== undefined) {
        sets.push('tracking_url_template = ?');
        params.push(parseTemplate(body.tracking_url_template));
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

      const [exists] = await pool.query<RowDataPacket[]>('SELECT id FROM couriers WHERE id = ? LIMIT 1', [id]);
      if (!Array.isArray(exists) || exists.length === 0) {
        return res.status(404).json({ error: 'Courier not found' });
      }
      await pool.query(`UPDATE couriers SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      return res.status(200).json({ success: true });
    }

    // DELETE
    const id = parseId(body.id ?? req.query.id);
    const [exists] = await pool.query<RowDataPacket[]>('SELECT id FROM couriers WHERE id = ? LIMIT 1', [id]);
    if (!Array.isArray(exists) || exists.length === 0) {
      return res.status(404).json({ error: 'Courier not found' });
    }

    let inUse = false;
    try {
      const [used] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM orders WHERE courier_id = ?',
        [id]
      );
      inUse = Number((Array.isArray(used) ? used[0]?.c : 0) || 0) > 0;
    } catch (err) {
      // orders.courier_id missing (migration 0009 partly applied): never hard delete.
      if (!isMissingColumn(err)) throw err;
      inUse = true;
    }

    if (inUse) {
      await pool.query('UPDATE couriers SET active = 0 WHERE id = ?', [id]);
      return res.status(200).json({ success: true, deactivated: true, deleted: false });
    }
    await pool.query('DELETE FROM couriers WHERE id = ?', [id]);
    return res.status(200).json({ success: true, deactivated: false, deleted: true });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isMissingTable(error) || isMissingColumn(error)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    console.error('[admin-couriers] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
