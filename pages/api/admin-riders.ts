import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';
import { canonicalPkMobile, digitsOnly } from '../../lib/customerIdentity';

/**
 * Riders CRUD (SANDY-BATCH-17 own-rider dispatch). super_admin only (settings:shipping).
 *
 * GET / POST / PATCH / DELETE. Phone is canonical PK mobile (03XXXXXXXXX), unique.
 * DELETE soft-deactivates when orders.rider_id references the rider; else hard deletes.
 * Missing table/column => 503. No runtime DDL.
 */

const NAME_MAX = 100;
const PHONE_MAX = 20;

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

function parseId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Valid rider id is required');
  return n;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Rider name is required');
  const t = raw.trim();
  if (!t || t.length > NAME_MAX) throw new ValidationError(`Rider name must be 1-${NAME_MAX} characters`);
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) throw new ValidationError('Rider name contains invalid characters');
  }
  if (/[<>]/.test(t)) throw new ValidationError('Rider name contains invalid characters');
  return t;
}

/** Canonical PK mobile only (03XXXXXXXXX). */
function parsePhone(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Rider phone is required');
  const t = raw.trim();
  if (!t || t.length > 40) throw new ValidationError('Rider phone must be a Pakistani mobile number');
  const digits = digitsOnly(t);
  const pk = canonicalPkMobile(digits);
  if (!pk || pk.length > PHONE_MAX) {
    throw new ValidationError('Rider phone must be a Pakistani mobile number');
  }
  return pk;
}

function parseSort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new ValidationError('Invalid sort order');
  return n;
}

type RiderRow = RowDataPacket & {
  id: number;
  name: string;
  phone: string;
  active: number;
  sort_order: number;
};

function serialise(row: RiderRow) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    phone: String(row.phone ?? ''),
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
      const [rows] = await pool.query<RiderRow[]>(
        'SELECT id, name, phone, active, sort_order FROM riders ORDER BY sort_order ASC, id ASC'
      );
      return res.status(200).json({
        success: true,
        riders: (Array.isArray(rows) ? rows : []).map(serialise),
      });
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    if (method === 'POST') {
      const name = parseName(body.name);
      const phone = parsePhone(body.phone);
      const active = body.active === undefined ? 1 : toFlag(body.active);
      if (active === null) throw new ValidationError('Invalid active flag');
      const sort = parseSort(body.sort_order);
      try {
        const [result] = await pool.query<ResultSetHeader>(
          'INSERT INTO riders (name, phone, active, sort_order) VALUES (?, ?, ?, ?)',
          [name, phone, active, sort]
        );
        return res.status(200).json({ success: true, id: Number(result.insertId) });
      } catch (err) {
        const e = err as { errno?: number; code?: string };
        if (e?.errno === 1062 || e?.code === 'ER_DUP_ENTRY') {
          throw new ValidationError('A rider with this phone already exists', 409);
        }
        throw err;
      }
    }

    if (method === 'PATCH') {
      const id = parseId(body.id);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        sets.push('name = ?');
        params.push(parseName(body.name));
      }
      if (body.phone !== undefined) {
        sets.push('phone = ?');
        params.push(parsePhone(body.phone));
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

      const [exists] = await pool.query<RowDataPacket[]>('SELECT id FROM riders WHERE id = ? LIMIT 1', [id]);
      if (!Array.isArray(exists) || exists.length === 0) {
        return res.status(404).json({ error: 'Rider not found' });
      }
      try {
        await pool.query(`UPDATE riders SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      } catch (err) {
        const e = err as { errno?: number; code?: string };
        if (e?.errno === 1062 || e?.code === 'ER_DUP_ENTRY') {
          throw new ValidationError('A rider with this phone already exists', 409);
        }
        throw err;
      }
      return res.status(200).json({ success: true });
    }

    const id = parseId(body.id ?? req.query.id);
    const [exists] = await pool.query<RowDataPacket[]>('SELECT id FROM riders WHERE id = ? LIMIT 1', [id]);
    if (!Array.isArray(exists) || exists.length === 0) {
      return res.status(404).json({ error: 'Rider not found' });
    }

    let inUse = false;
    try {
      const [used] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM orders WHERE rider_id = ?',
        [id]
      );
      inUse = Number((Array.isArray(used) ? used[0]?.c : 0) || 0) > 0;
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
      inUse = true;
    }

    if (inUse) {
      await pool.query('UPDATE riders SET active = 0 WHERE id = ?', [id]);
      return res.status(200).json({ success: true, deactivated: true, deleted: false });
    }
    await pool.query('DELETE FROM riders WHERE id = ?', [id]);
    return res.status(200).json({ success: true, deactivated: false, deleted: true });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isMissingTable(error) || isMissingColumn(error)) {
      return res.status(503).json({ error: 'Service unavailable' });
    }
    console.error('[admin-riders] failed', (error as { code?: string })?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
