import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { RL_GENERAL, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import { formatPrice } from '../../lib/site';
import { requirePermission } from '../../lib/adminPermissions';
import type { AdminSession } from '../../lib/adminAuth';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { allowed } = RL_GENERAL(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  const isValidate = req.method === 'POST' && req.query.action === 'validate';
  // Set for every non-validate request (admin branches); null only on the public validate path.
  let session: AdminSession | null = null;
  if (!isValidate) {
    session = await requirePermission(
      req,
      res,
      req.method === 'GET' ? 'coupons:view' : 'coupons:write'
    );
    if (!session) return;
  }

  try {
    // The coupons table comes from migrations/0003-admin-schema.sql. This handler never creates
    // the table and never seeds coupon rows (no WELCOME10 / SAVE5 auto-insert).
    const { action } = req.query;

    if (req.method === 'POST' && action === 'validate') {
      const { code, cart_total } = req.body;
      if (!code) return res.status(400).json({ valid:false, message:"Please enter a coupon code" });

      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM coupons WHERE code=? AND is_active=1',
        [String(code).toUpperCase().trim()]
      );

      if (!rows.length) return res.status(200).json({ valid:false, message:"Invalid coupon code" });

      const c = rows[0];
      if (c.expires_at && new Date(c.expires_at) < new Date()) return res.status(200).json({ valid:false, message:"Coupon has expired" });
      if (c.usage_limit !== null && c.used_count >= c.usage_limit) return res.status(200).json({ valid:false, message:"Coupon usage limit reached" });
      if (cart_total < Number(c.minimum_order)) return res.status(200).json({ valid:false, message:`Minimum order ${formatPrice(c.minimum_order)} required` });

      const discount = c.type === 'percentage'
        ? Math.min(Number(cart_total) * Number(c.value) / 100, Number(cart_total))
        : Math.min(Number(c.value), Number(cart_total));

      return res.status(200).json({
        valid: true, code: c.code, type: c.type, value: Number(c.value),
        discount_amount: Math.round(discount * 100) / 100,
        message: `✅ ${c.code} applied!`,
      });
    }

    if (req.method === 'GET') {
      const [rows] = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
      return res.status(200).json(Array.isArray(rows)?rows:[]);
    }

    if (req.method === 'POST') {
      const { code, type, value, minimum_order, usage_limit, expires_at } = req.body;
      if (!code||!type||!value) return res.status(400).json({ error:'Missing required fields' });
      const [r] = await pool.query<ResultSetHeader>(
        'INSERT INTO coupons (code,type,value,minimum_order,usage_limit,expires_at) VALUES (?,?,?,?,?,?)',
        [String(code).toUpperCase().trim(), type, value, minimum_order||0, usage_limit||null, expires_at||null]
      );
      await recordAudit(pool, {
        actor: session!,
        action: 'create',
        entityType: 'coupon',
        entityId: r.insertId,
        summary: `Created coupon ${String(code).toUpperCase().trim().slice(0, 40)}`,
        detail: {
          coupon_code: String(code).toUpperCase().trim(),
          type,
          value,
          minimum_order: minimum_order||0,
          usage_limit: usage_limit||null,
          expires_at: expires_at||null,
        },
        req,
      });
      return res.status(200).json({ success:true, id:r.insertId });
    }

    if (req.method === 'PUT') {
      const { id, code, type, value, minimum_order, usage_limit, expires_at, is_active } = req.body;
      const [beforeRows] = await pool.query<RowDataPacket[]>(
        'SELECT code,type,value,minimum_order,usage_limit,expires_at,is_active FROM coupons WHERE id=? LIMIT 1',
        [id]
      );
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query(
        'UPDATE coupons SET code=?,type=?,value=?,minimum_order=?,usage_limit=?,expires_at=?,is_active=? WHERE id=?',
        [String(code).toUpperCase().trim(), type, value, minimum_order||0, usage_limit||null, expires_at||null, is_active?1:0, id]
      );
      if (before) {
        const iso = (d: unknown) => (d ? new Date(d as string | number | Date).toISOString() : null);
        await recordAudit(pool, {
          actor: session!,
          action: 'update',
          entityType: 'coupon',
          entityId: id,
          summary: `Updated coupon ${String(code).toUpperCase().trim().slice(0, 40)}`,
          detail: {
            changes: auditFieldDiff(
              {
                coupon_code: before.code,
                type: before.type,
                value: Number(before.value),
                minimum_order: Number(before.minimum_order || 0),
                usage_limit: before.usage_limit == null ? null : Number(before.usage_limit),
                expires_at: iso(before.expires_at),
                is_active: Number(before.is_active) ? 1 : 0,
              },
              {
                coupon_code: String(code).toUpperCase().trim(),
                type,
                value: Number(value),
                minimum_order: Number(minimum_order || 0),
                usage_limit: usage_limit ? Number(usage_limit) : null,
                expires_at: iso(expires_at),
                is_active: is_active ? 1 : 0,
              }
            ),
          },
          req,
        });
      }
      return res.status(200).json({ success:true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      const [beforeRows] = await pool.query<RowDataPacket[]>('SELECT code FROM coupons WHERE id=? LIMIT 1', [id]);
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query('DELETE FROM coupons WHERE id=?', [id]);
      if (before) {
        await recordAudit(pool, {
          actor: session!,
          action: 'delete',
          entityType: 'coupon',
          entityId: String(id),
          summary: `Deleted coupon ${String(before.code ?? id).slice(0, 40)}`,
          detail: { coupon_code: before.code },
          req,
        });
      }
      return res.status(200).json({ success:true });
    }

    return res.status(405).json({ error:'Method not allowed' });
  } catch (error: unknown) {
    console.error('[api/coupons] request failed', (error as { code?: unknown } | null | undefined)?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
