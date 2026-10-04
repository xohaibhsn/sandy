import type { NextApiRequest, NextApiResponse } from 'next';
import type { RowDataPacket } from 'mysql2';
import pool from '../../lib/db';
import { ensureProductsTable } from '../../lib/ensureShopTables';
import { ensureCategoriesTable } from '../../lib/ensureCategories';
import { parsePrice } from '../../lib/site';
import { requireAdmin, requireRole } from '../../lib/adminAuth';
import { sanitizeRichHtml } from '../../lib/richHtmlSanitizer';
import { assertSafeImageUrl, UrlValidationError } from '../../lib/urlValidation';

function toSlug(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}


type CategoryLookupRow = RowDataPacket & { name: string; active: number };
type ProductCategoryRow = RowDataPacket & { category: string | null };

async function resolveProductCategory(
  requestedRaw: unknown,
  existingCategory: string | null | undefined,
  isCreate: boolean
): Promise<{ ok: true; category: string } | { ok: false; error: string }> {
  if (typeof requestedRaw !== 'string') {
    return { ok: false, error: 'Please choose an active category' };
  }
  const category = requestedRaw.trim();
  if (!category || category.length > 100) {
    return { ok: false, error: 'Please choose an active category' };
  }

  await ensureCategoriesTable();
  const [rows] = await pool.query<CategoryLookupRow[]>(
    'SELECT name, active FROM categories WHERE name = ? LIMIT 1',
    [category]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return { ok: false, error: 'Please choose an active category' };
  }

  const existing =
    existingCategory == null || existingCategory === undefined
      ? ''
      : String(existingCategory).trim();
  const unchanged = !isCreate && existing !== '' && category === existing;

  if (unchanged) {
    return { ok: true, category };
  }

  if (Number(row.active) === 0) {
    return { ok: false, error: 'Please choose an active category' };
  }

  return { ok: true, category };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
  } else {
    const session = await requireRole(req, res, ['super_admin', 'manager']);
    if (!session) return;
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
      const categoryResult = await resolveProductCategory(category, null, true);
      if (!categoryResult.ok) {
        return res.status(400).json({ error: categoryResult.error });
      }
      const finalCategory = categoryResult.category;
      const finalSeoTitle = (seo_title || '').trim() || name;
      const finalMetaDesc = (meta_description || '').trim() || (short_description || '').trim() || '';
      const safeDescription = sanitizeRichHtml(description || '');
      const safeShortDescription = sanitizeRichHtml(short_description || '');
      const safeFullDescription = sanitizeRichHtml(full_description || '');
      const safeImage = assertSafeImageUrl(image ?? '');
      const safeOgImage = assertSafeImageUrl(og_image ?? '');

      try {
        const [result]: any = await pool.query(
          `INSERT INTO products (name, slug, description, price, category, badge, image, stock, active,
            short_description, full_description, seo_title, meta_description, focus_keyword, features, og_image)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [name, finalSlug, safeDescription, numericPrice, finalCategory, badge || null, safeImage || null, stock || 'Digital',
           safeShortDescription, safeFullDescription, finalSeoTitle, finalMetaDesc,
           focus_keyword || '', features || '', safeOgImage]
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
      const [existingRows] = await pool.query<ProductCategoryRow[]>(
        'SELECT category FROM products WHERE id = ? LIMIT 1',
        [id]
      );
      const existingProduct = Array.isArray(existingRows) ? existingRows[0] : null;
      if (!existingProduct) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const categoryResult = await resolveProductCategory(
        category,
        existingProduct.category,
        false
      );
      if (!categoryResult.ok) {
        return res.status(400).json({ error: categoryResult.error });
      }
      const finalCategory = categoryResult.category;
      const finalSeoTitle = (seo_title || '').trim() || name;
      const finalMetaDesc = (meta_description || '').trim() || (short_description || '').trim() || '';
      const safeDescription = sanitizeRichHtml(description || '');
      const safeShortDescription = sanitizeRichHtml(short_description || '');
      const safeFullDescription = sanitizeRichHtml(full_description || '');
      const safeImage = assertSafeImageUrl(image ?? '');
      const safeOgImage = assertSafeImageUrl(og_image ?? '');

      try {
        await pool.query(
          `UPDATE products SET name=?, slug=?, description=?, price=?, category=?, badge=?, image=?, stock=?, active=?,
            short_description=?, full_description=?, seo_title=?, meta_description=?, focus_keyword=?, features=?, og_image=?
           WHERE id=?`,
          [name, finalSlug, safeDescription, numericPrice, finalCategory, badge || null, safeImage || null, stock, active ?? 1,
           safeShortDescription, safeFullDescription, finalSeoTitle, finalMetaDesc,
           focus_keyword || '', features || '', safeOgImage, id]
        );
        return res.status(200).json({ success: true, slug: finalSlug });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Slug already exists. Choose a different URL slug.' });
        }
        throw err;
      }
    }


    if (req.method === 'PATCH') {
      const { id, active } = req.body || {};
      const productId = typeof id === 'number' ? id : Number(id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Valid product id is required' });
      }

      let normalized = null;
      if (active === true || active === 1 || active === '1') normalized = 1;
      else if (active === false || active === 0 || active === '0') normalized = 0;
      if (normalized === null) {
        return res.status(400).json({ error: 'active must be 0 or 1' });
      }

      const updateResult = await pool.query(
        'UPDATE products SET active = ? WHERE id = ?',
        [normalized, productId]
      );
      const result = Array.isArray(updateResult) ? updateResult[0] as { affectedRows?: number } : updateResult as { affectedRows?: number };
      if (!result || result.affectedRows === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }
      return res.status(200).json({ success: true, id: productId, active: normalized });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      await pool.query('DELETE FROM products WHERE id = ?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    if (error instanceof UrlValidationError) {
      return res.status(400).json({ error: 'Invalid URL or path' });
    }
    const code = error?.code || '';
    if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied/i.test(String(error?.message || ''))) {
      return res.status(500).json({
        error: 'Database connection failed. On Hostinger set DB_HOST to 127.0.0.1 (not srvXXX.hstgr.io).',
      });
    }
    return res.status(500).json({ error: error.message });
  }
}
