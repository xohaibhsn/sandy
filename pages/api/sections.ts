import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getAdminSession } from '../../lib/adminAuth';
import { hasPermission, requirePermission } from '../../lib/adminPermissions';
import { recordAudit } from '../../lib/auditLog';
import {
  assertSafeImageUrl,
  assertSafeInternalPath,
  UrlValidationError,
} from '../../lib/urlValidation';

/** Exact section JSON keys that carry navigable URLs or image refs. */
function validateSectionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => validateSectionValue(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'button_link' || k === 'secondary_button_link') {
        if (typeof v !== 'string') {
          throw new UrlValidationError('Invalid URL or path');
        }
        out[k] = assertSafeInternalPath(v);
      } else if (k === 'hero_image') {
        out[k] = assertSafeImageUrl(v);
      } else {
        out[k] = validateSectionValue(v);
      }
    }
    return out;
  }
  return value;
}

/*
 * The site_content table (with section_order / is_visible / json content_type) and the default
 * section rows come from migrations/0003 and 0004 (owner-run). This handler never creates or
 * alters tables and never rewrites existing section JSON.
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const { page, all } = req.query;
      let query = 'SELECT content_key,content_value,content_type,page_name,label,section_order,is_visible FROM site_content WHERE page_name=? AND content_type="json"';
      const params: any[] = [page || 'home'];
      // Soft check only: GET never returns 401/403. `all` is honored only for sections:write sessions.
      let includeHidden = false;
      if (all) {
        const { session } = await getAdminSession(req);
        includeHidden = !!session && hasPermission(session.role, 'sections:write');
      }
      if (!includeHidden) query += ' AND is_visible=1';
      query += ' ORDER BY section_order ASC';
      const [rows]: any = await pool.query(query, params);
      const result = (Array.isArray(rows)?rows:[]).map((r:any) => ({
        key: r.content_key,
        label: r.label,
        page: r.page_name,
        order: r.section_order,
        visible: !!r.is_visible,
        data: (() => { try { return JSON.parse(r.content_value); } catch { return {}; } })(),
      }));
      return res.status(200).json(result);
    }

    const session = await requirePermission(req, res, 'sections:write');
    if (!session) return;


    if (req.method === 'POST') {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: 'Key required' });

      let parsed: unknown;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          return res.status(400).json({ error: 'Invalid section data' });
        }
      } else {
        parsed = value;
      }

      const validated = validateSectionValue(parsed);
      const json = JSON.stringify(validated);
      const [updateResult]: any = await pool.query('UPDATE site_content SET content_value=? WHERE content_key=?', [json, key]);
      if (Number(updateResult?.affectedRows ?? 1) > 0) {
        await recordAudit(pool, {
          actor: session,
          action: 'update',
          entityType: 'section',
          entityId: String(key),
          summary: `Updated section "${String(key).slice(0, 120)}"`,
          detail: { key, content: json },
          req,
        });
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const { action } = req.query;
      if (action === 'visibility') {
        const { key, is_visible } = req.body;
        const [beforeRows]: any = await pool.query('SELECT is_visible FROM site_content WHERE content_key=? LIMIT 1', [key]);
        const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
        await pool.query('UPDATE site_content SET is_visible=? WHERE content_key=?', [is_visible?1:0, key]);
        if (before) {
          await recordAudit(pool, {
            actor: session,
            action: 'status_change',
            entityType: 'section',
            entityId: String(key),
            summary: `${is_visible ? 'Showed' : 'Hid'} section "${String(key).slice(0, 120)}"`,
            detail: { key, changes: { is_visible: { from: Number(before.is_visible) ? 1 : 0, to: is_visible ? 1 : 0 } } },
            req,
          });
        }
        return res.status(200).json({ success: true });
      }
      if (action === 'reorder') {
        const { order } = req.body;
        for (const item of (order||[])) {
          await pool.query('UPDATE site_content SET section_order=? WHERE content_key=?', [item.section_order, item.key]);
        }
        await recordAudit(pool, {
          actor: session,
          action: 'update',
          entityType: 'section',
          entityId: 'reorder',
          summary: `Reordered ${(order||[]).length} sections`,
          detail: {
            order: (order||[]).slice(0, 50).map((item: any) => ({ key: item?.key, section_order: item?.section_order })),
          },
          req,
        });
        return res.status(200).json({ success: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    if (error instanceof UrlValidationError) {
      return res.status(400).json({ error: 'Invalid URL or path' });
    }
    console.error('[api/sections] request failed', error?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
