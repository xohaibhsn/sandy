import type { NextApiRequest, NextApiResponse } from 'next';
import { RL_SEARCH, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import { ensureShopTables } from '../../lib/ensureShopTables';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = RL_SEARCH(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(200).json([]);

  try {
    await ensureShopTables();
    const term = `%${q}%`;
    const [rows]: any = await pool.query(
      `SELECT id, name, price, image, category, badge,
        COALESCE(NULLIF(slug, ''), LOWER(REPLACE(REPLACE(name, ' ', '-'), '/', ''))) as slug
       FROM products
       WHERE (active IS NULL OR active=1)
         AND (name LIKE ? OR short_description LIKE ? OR focus_keyword LIKE ?)
       LIMIT 6`,
      [term, term, term]
    );
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (error: any) {
    console.error('[api/search]', error?.message || error);
    return res.status(200).json([]);
  }
}
