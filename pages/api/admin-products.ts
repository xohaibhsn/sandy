import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { ensureProductsTable } from '../../lib/ensureShopTables';
import { parsePrice } from '../../lib/site';

function checkAdminAuth(req: NextApiRequest): boolean {
  const session = req.headers['x-admin-session'] || req.cookies?.sAdminSession;
  return !!session;
}

function toSlug(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Forbidden' });
  // Writers cannot mutate products
  const role = req.headers['x-admin-role'] as string;
  if (req.method !== 'GET' && role === 'writer') {
    return res.status(403).json({ error: 'Forbidden: Writers cannot modify products' });
  }
  try {
    await ensureProductsTable();

    if (req.method === 'GET') {
      try {
        const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
        return res.status(200).json(Array.isArray(rows) ? rows : []);
      } catch (err: any) {
        console.error('[api/admin-products] GET', err?.message || err);
        const [rows] = await pool.query('SELECT * FROM products');
        return res.status(200).json(Array.isArray(rows) ? rows : []);
      }
    }

    if (req.method === 'POST') {
      const { name, description, price, category, badge, image, stock, slug,
        short_description, full_description, seo_title, meta_description, focus_keyword, features, og_image } = req.body;

      const finalSlug = toSlug(slug || name);
      if (!name || !finalSlug) {
        return res.status(400).json({ error: 'Name and slug are required' });
      }

      const numericPrice = parsePrice(price);
      const finalSeoTitle = (seo_title || '').trim() || name;
      const finalMetaDesc = (meta_description || '').trim() || (short_description || '').trim() || '';

      try {
        const [result]: any = await pool.query(
          `INSERT INTO products (name, slug, description, price, category, badge, image, stock, active,
            short_description, full_description, seo_title, meta_description, focus_keyword, features, og_image)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [name, finalSlug, description || '', numericPrice, category, badge || null, image || null, stock || 'Digital',
           short_description || '', full_description || '', finalSeoTitle, finalMetaDesc,
           focus_keyword || '', features || '', og_image || '']
        );
        return res.status(200).json({ success: true, id: result.insertId, slug: finalSlug });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Slug already exists. Choose a different URL slug.' });
        }
        throw err;
      }
    }

    if (req.method === 'PUT') {
      const { id, name, description, price, category, badge, image, stock, active, slug,
        short_description, full_description, seo_title, meta_description, focus_keyword, features, og_image } = req.body;

      const finalSlug = toSlug(slug || name);
      if (!id || !name || !finalSlug) {
        return res.status(400).json({ error: 'id, name and slug are required' });
      }

      const numericPrice = parsePrice(price);
      const finalSeoTitle = (seo_title || '').trim() || name;
      const finalMetaDesc = (meta_description || '').trim() || (short_description || '').trim() || '';

      try {
        await pool.query(
          `UPDATE products SET name=?, slug=?, description=?, price=?, category=?, badge=?, image=?, stock=?, active=?,
            short_description=?, full_description=?, seo_title=?, meta_description=?, focus_keyword=?, features=?, og_image=?
           WHERE id=?`,
          [name, finalSlug, description || '', numericPrice, category, badge || null, image || null, stock, active ?? 1,
           short_description || '', full_description || '', finalSeoTitle, finalMetaDesc,
           focus_keyword || '', features || '', og_image || '', id]
        );
        return res.status(200).json({ success: true, slug: finalSlug });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Slug already exists. Choose a different URL slug.' });
        }
        throw err;
      }
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      await pool.query('DELETE FROM products WHERE id = ?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
