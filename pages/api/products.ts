import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { ensureShopTables } from '../../lib/ensureShopTables';

const ACTIVE_WHERE = '(active IS NULL OR active = 1)';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureShopTables();

    const { slug, id, category, minPrice, maxPrice, sort } = req.query;

    if (id) {
      const [rows]: any = await pool.query(
        `SELECT * FROM products WHERE id=? AND ${ACTIVE_WHERE}`,
        [id]
      );
      return res.status(200).json(rows[0] || null);
    }

    if (slug) {
      const s = String(slug).toLowerCase();
      const [rows]: any = await pool.query(
        `SELECT * FROM products
         WHERE ${ACTIVE_WHERE} AND (
           slug = ?
           OR LOWER(REPLACE(REPLACE(name,' ','-'),'/','')) = ?
         )
         LIMIT 1`,
        [s, s]
      );
      return res.status(200).json(rows[0] || null);
    }

    let query = `SELECT * FROM products WHERE ${ACTIVE_WHERE}`;
    const params: any[] = [];

    if (category && category !== 'All') {
      query += ' AND category=?';
      params.push(category);
    }
    if (minPrice) {
      query += ' AND price >= ?';
      params.push(Number(minPrice));
    }
    if (maxPrice) {
      query += ' AND price <= ?';
      params.push(Number(maxPrice));
    }

    const sortMap: Record<string, string> = {
      price_asc: 'price ASC',
      price_desc: 'price DESC',
      newest: 'created_at DESC',
      featured: 'id ASC',
    };
    query += ` ORDER BY ${sortMap[String(sort)] || 'id ASC'}`;

    const [rows] = await pool.query(query, params);
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (error: any) {
    console.error('[api/products]', error?.message || error);
    // Catalog must return an array so the public page does not show a hard error
    // for a missing column / first-boot schema race.
    if (!req.query.id && !req.query.slug) {
      return res.status(200).json([]);
    }
    return res.status(500).json({ error: error.message });
  }
}
