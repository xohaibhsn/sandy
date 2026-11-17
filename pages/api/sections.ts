import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getAdminSession } from '../../lib/adminAuth';
import { hasPermission, requirePermission } from '../../lib/adminPermissions';
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
      await pool.query('UPDATE site_content SET content_value=? WHERE content_key=?', [json, key]);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT') {
      const { action } = req.query;
      if (action === 'visibility') {
        const { key, is_visible } = req.body;
        await pool.query('UPDATE site_content SET is_visible=? WHERE content_key=?', [is_visible?1:0, key]);
        return res.status(200).json({ success: true });
      }
      if (action === 'reorder') {
        const { order } = req.body;
        for (const item of (order||[])) {
          await pool.query('UPDATE site_content SET section_order=? WHERE content_key=?', [item.section_order, item.key]);
        }
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
