import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import pool from '../../lib/db';
import { requireRole } from '../../lib/adminAuth';
import {
  TAX_CONFIG_UNAVAILABLE_MESSAGE,
  classifyTaxDbError,
  toTaxUnavailable,
} from '../../lib/taxStore';

/**
 * TAX-CONFIG-01 admin endpoint — super_admin ONLY (every method, enforced explicitly).
 *
 * GET  -> { success, classes, rates, rules } (all rows, incl. future-dated)
 * POST -> create_rate | create_rule | create_class   (rates/rules are INSERT-only: a change is a NEW dated row)
 * PUT  -> update a class's applies_to / active (classes carry no effective date; orders keep their own snapshot)
 *
 * No runtime DDL. If the tax tables are missing the response is 503 { error: "Tax configuration unavailable" }.
 */

const APPLIES_TO = new Set(['domestic', 'international', 'both']);
const TAX_BASES = new Set(['after_discount', 'before_discount']);
const PAST_GRACE_MS = 5 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function toFlag(v: unknown): 0 | 1 | null {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return null;
}

function toSlug(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseEffectiveFrom(raw: unknown): { ok: true; value: Date } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: new Date() };
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid effective date' };
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return { ok: false, error: 'Invalid effective date' };
  const now = Date.now();
  if (d.getTime() < now - PAST_GRACE_MS) {
    return { ok: false, error: 'Effective date cannot be in the past. Changes apply to new orders only.' };
  }
  if (d.getTime() > now + MAX_FUTURE_MS) {
    return { ok: false, error: 'Effective date is too far in the future' };
  }
  return { ok: true, value: d };
}

function parseRatePercent(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d{1,3}(\.\d{1,4})?$/.test(raw.trim())) n = Number(raw.trim());
  else return { ok: false, error: 'Rate must be a number between 0 and 100' };
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ok: false, error: 'Rate must be a number between 0 and 100' };
  }
  // at most 4 decimals (DECIMAL(7,4))
  if (Math.abs(Math.round(n * 10000) / 10000 - n) > 1e-9) {
    return { ok: false, error: 'Rate can have at most 4 decimal places' };
  }
  return { ok: true, value: Math.round(n * 10000) / 10000 };
}

function parseTaxLabel(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Tax label is required' };
  const t = raw.trim();
  if (!t || t.length > 64) return { ok: false, error: 'Tax label must be 1–64 characters' };
  if (/[\u0000-\u001f\u007f<>]/.test(t)) {
    return { ok: false, error: 'Tax label contains invalid characters' };
  }
  return { ok: true, value: t };
}

function unavailable(res: NextApiResponse, err: unknown, ctx: string) {
  toTaxUnavailable(err, ctx);
  return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  // super_admin only, for every method (known RBAC gap: do not rely on UI hiding).
  const session = await requireRole(req, res, ['super_admin']);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    if (req.method === 'GET') {
      try {
        const [classes] = await pool.query<RowDataPacket[]>(
          `SELECT id, name, slug, applies_to, active, sort_order, created_at
           FROM tax_classes ORDER BY sort_order ASC, id ASC`
        );
        const [rates] = await pool.query<RowDataPacket[]>(
          `SELECT id, tax_class_id, rate_percent, effective_from, created_at, created_by
           FROM tax_rates ORDER BY effective_from DESC, id DESC`
        );
        const [rules] = await pool.query<RowDataPacket[]>(
          `SELECT id, tax_base, shipping_taxable, rounding, tax_label, prices_include_tax, effective_from, created_at
           FROM tax_rules ORDER BY effective_from DESC, id DESC`
        );
        return res.status(200).json({
          success: true,
          classes: Array.isArray(classes) ? classes : [],
          rates: Array.isArray(rates) ? rates : [],
          rules: Array.isArray(rules) ? rules : [],
        });
      } catch (err) {
        return unavailable(res, err, 'admin-tax:GET');
      }
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : null;

    if (req.method === 'POST') {
      if (!body) return res.status(400).json({ error: 'Invalid request' });
      const action = body.action;

      if (action === 'create_rate') {
        const classId = Number(body.tax_class_id);
        if (!Number.isInteger(classId) || classId <= 0) {
          return res.status(400).json({ error: 'Choose a tax class' });
        }
        const rate = parseRatePercent(body.rate_percent);
        if (!rate.ok) return res.status(400).json({ error: rate.error });
        const from = parseEffectiveFrom(body.effective_from);
        if (!from.ok) return res.status(400).json({ error: from.error });

        try {
          const [classRows] = await pool.query<RowDataPacket[]>(
            'SELECT id FROM tax_classes WHERE id = ? LIMIT 1',
            [classId]
          );
          if (!classRows.length) return res.status(400).json({ error: 'Tax class not found' });
          // INSERT only — never update a rate row in place.
          const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO tax_rates (tax_class_id, rate_percent, effective_from, created_by)
             VALUES (?, ?, ?, ?)`,
            [classId, rate.value, from.value, session.name]
          );
          return res.status(200).json({ success: true, id: Number(result.insertId) });
        } catch (err) {
          return unavailable(res, err, 'admin-tax:create_rate');
        }
      }

      if (action === 'create_rule') {
        const base = body.tax_base;
        if (typeof base !== 'string' || !TAX_BASES.has(base)) {
          return res.status(400).json({ error: 'Invalid tax base' });
        }
        const shipping = toFlag(body.shipping_taxable);
        const inclusive = toFlag(body.prices_include_tax);
        if (shipping === null || inclusive === null) {
          return res.status(400).json({ error: 'Invalid rule flags' });
        }
        const label = parseTaxLabel(body.tax_label);
        if (!label.ok) return res.status(400).json({ error: label.error });
        const from = parseEffectiveFrom(body.effective_from);
        if (!from.ok) return res.status(400).json({ error: from.error });

        try {
          // INSERT only — never update a rules row in place.
          const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO tax_rules (tax_base, shipping_taxable, rounding, tax_label, prices_include_tax, effective_from)
             VALUES (?, ?, 'per_line_whole_rupee', ?, ?, ?)`,
            [base, shipping, label.value, inclusive, from.value]
          );
          return res.status(200).json({ success: true, id: Number(result.insertId) });
        } catch (err) {
          return unavailable(res, err, 'admin-tax:create_rule');
        }
      }

      if (action === 'create_class') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) {
          return res.status(400).json({ error: 'Class name must be 1–100 characters' });
        }
        const slug = toSlug(typeof body.slug === 'string' && body.slug.trim() ? body.slug : name);
        if (!slug || slug.length > 100) return res.status(400).json({ error: 'Invalid class slug' });
        const appliesTo = body.applies_to === undefined ? 'both' : body.applies_to;
        if (typeof appliesTo !== 'string' || !APPLIES_TO.has(appliesTo)) {
          return res.status(400).json({ error: 'Invalid applies_to' });
        }
        const sortRaw = body.sort_order === undefined || body.sort_order === '' ? 100 : Number(body.sort_order);
        if (!Number.isInteger(sortRaw) || sortRaw < 0 || sortRaw > 100000) {
          return res.status(400).json({ error: 'Invalid sort order' });
        }
        try {
          const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO tax_classes (name, slug, applies_to, active, sort_order)
             VALUES (?, ?, ?, 1, ?)`,
            [name, slug, appliesTo, sortRaw]
          );
          return res.status(200).json({ success: true, id: Number(result.insertId) });
        } catch (err) {
          const e = err as { code?: string; errno?: number };
          if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
            return res.status(409).json({ error: 'A tax class with this name/slug already exists' });
          }
          return unavailable(res, err, 'admin-tax:create_class');
        }
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'PUT') {
      if (!body) return res.status(400).json({ error: 'Invalid request' });
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Class id required' });
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.applies_to !== undefined) {
        if (typeof body.applies_to !== 'string' || !APPLIES_TO.has(body.applies_to)) {
          return res.status(400).json({ error: 'Invalid applies_to' });
        }
        sets.push('applies_to = ?');
        params.push(body.applies_to);
      }
      if (body.active !== undefined) {
        const f = toFlag(body.active);
        if (f === null) return res.status(400).json({ error: 'Invalid active flag' });
        sets.push('active = ?');
        params.push(f);
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      try {
        const [result] = await pool.query<ResultSetHeader>(
          `UPDATE tax_classes SET ${sets.join(', ')} WHERE id = ?`,
          [...params, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Tax class not found' });
        return res.status(200).json({ success: true });
      } catch (err) {
        return unavailable(res, err, 'admin-tax:PUT');
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: unknown) {
    console.error('[admin-tax] Unexpected failure:', classifyTaxDbError(error), error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Server error' });
  }
}
