import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { ensureProductsTable } from '../../lib/ensureShopTables';

function sortSql(sort: unknown): string {
  const sortMap: Record<string, string> = {
    price_asc: 'price ASC',
    price_desc: 'price DESC',
    newest: 'id DESC',
    featured: 'id ASC',
  };
  return sortMap[String(sort)] || 'id ASC';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureProductsTable();

    const { slug, id, category, minPrice, maxPrice, sort } = req.query;

    if (id) {
      const [rows]: any = await pool.query('SELECT * FROM products WHERE id=?', [id]);
      return res.status(200).json(rows[0] || null);
    }

    if (slug) {
      const s = String(slug).toLowerCase();
      const [rows]: any = await pool.query(
        `SELECT * FROM products
         WHERE slug = ?
            OR LOWER(REPLACE(REPLACE(name,' ','-'),'/','')) = ?
         LIMIT 1`,
        [s, s]
      );
      return res.status(200).json(rows[0] || null);
    }

    const extra: string[] = [];
    const params: any[] = [];

    if (category && category !== 'All') {
      extra.push('category=?');
      params.push(category);
    }
    if (minPrice) {
      extra.push('price >= ?');
      params.push(Number(minPrice));
    }
    if (maxPrice) {
      extra.push('price <= ?');
      params.push(Number(maxPrice));
    }

    const where = extra.length ? `WHERE ${extra.join(' AND ')}` : '';
    const order = sortSql(sort);

    try {
      const [rows] = await pool.query(
        `SELECT * FROM products ${where} ORDER BY ${order}`,
        params
      );
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      console.error('[api/products] filtered query', err?.message || err);
      const [rows] = await pool.query('SELECT * FROM products');
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }
  } catch (error: any) {
    console.error('[api/products]', error?.message || error);
    try {
      const [rows] = await pool.query('SELECT * FROM products');
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    } catch {
      if (!req.query.id && !req.query.slug) {
        return res.status(200).json([]);
      }
      return res.status(500).json({ error: error.message });
    }
  }
}
