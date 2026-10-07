import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { SITE_URL } from '../../lib/site';
import { getAdminSession, requireAdmin } from '../../lib/adminAuth';
import { sanitizeRichHtml } from '../../lib/richHtmlSanitizer';
import {
  assertSafeCanonicalUrl,
  assertSafeImageUrl,
  UrlValidationError,
} from '../../lib/urlValidation';

function resolveBlogFeaturedImage(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return assertSafeImageUrl('');
  }
  return assertSafeImageUrl(raw);
}

function resolveBlogCanonical(raw: unknown, slug: unknown): string {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new UrlValidationError('Invalid URL or path');
  }
  const custom = typeof raw === 'string' ? raw.trim() : '';
  if (custom) {
    return assertSafeCanonicalUrl(custom, SITE_URL);
  }
  const slugPart = typeof slug === 'string' ? slug : '';
  return assertSafeCanonicalUrl(`${SITE_URL}/blog/${slugPart || ''}`, SITE_URL);
}

let initializationPromise: Promise<void> | null = null;

async function initializeBlog(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      slug VARCHAR(500),
      excerpt TEXT,
      content LONGTEXT,
      category VARCHAR(100) DEFAULT 'Guides',
      emoji VARCHAR(10) DEFAULT '📝',
      badge VARCHAR(50) DEFAULT 'guide',
      badgeText VARCHAR(50) DEFAULT 'Guide',
      featured_image VARCHAR(1000),
      meta_title VARCHAR(500),
      meta_description VARCHAR(500),
      focus_keyword VARCHAR(255),
      status VARCHAR(20) DEFAULT 'published',
      featured TINYINT(1) DEFAULT 0,
      active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const col of [
    "ALTER TABLE blog_posts ADD COLUMN slug VARCHAR(500) AFTER title",
    "ALTER TABLE blog_posts ADD COLUMN content LONGTEXT AFTER excerpt",
    "ALTER TABLE blog_posts ADD COLUMN featured_image VARCHAR(1000) AFTER badgeText",
    "ALTER TABLE blog_posts ADD COLUMN meta_title VARCHAR(500)",
    "ALTER TABLE blog_posts ADD COLUMN meta_description VARCHAR(500)",
    "ALTER TABLE blog_posts ADD COLUMN focus_keyword VARCHAR(255)",
    "ALTER TABLE blog_posts ADD COLUMN status VARCHAR(20) DEFAULT 'published'",
    "ALTER TABLE blog_posts ADD COLUMN featured TINYINT(1) DEFAULT 0",
    "ALTER TABLE blog_posts ADD COLUMN canonical_url VARCHAR(500)",
    "ALTER TABLE blog_posts ADD COLUMN faqs TEXT",
    "ALTER TABLE blog_posts ADD COLUMN active TINYINT(1) DEFAULT 1",
    "ALTER TABLE blog_posts ADD COLUMN badgeText VARCHAR(50) DEFAULT 'Guide'",
    "ALTER TABLE blog_posts ADD COLUMN emoji VARCHAR(10) DEFAULT '📝'",
  ]) { try { await pool.query(col); } catch {} }

  // Activate any existing posts that have NULL active (added before column existed)
  try { await pool.query("UPDATE blog_posts SET active=1 WHERE active IS NULL"); } catch {}

  // Replace IPTV wording in existing public blog content
  for (const [from, to] of [
    ['Premium IPTV & Streaming', 'Premium Streaming'],
    ['IPTV & Streaming Solutions', 'Streaming Solutions'],
    ['Premium IPTV', 'Premium Streaming'],
    ['Best IPTV', 'Best Streaming'],
    ['IPTV Subscriptions', 'Streaming Subscriptions'],
    ['IPTV service', 'streaming service'],
    ['IPTV Plans', 'Streaming Plans'],
    ['IPTV', 'Streaming'],
    ['iptv', 'streaming'],
  ] as const) {
    try {
      await pool.query(
        `UPDATE blog_posts SET
           title = REPLACE(title, ?, ?),
           excerpt = REPLACE(excerpt, ?, ?),
           content = REPLACE(content, ?, ?),
           meta_title = REPLACE(IFNULL(meta_title,''), ?, ?),
           meta_description = REPLACE(IFNULL(meta_description,''), ?, ?)
         WHERE title LIKE ? OR excerpt LIKE ? OR content LIKE ? OR IFNULL(meta_title,'') LIKE ? OR IFNULL(meta_description,'') LIKE ?`,
        [from, to, from, to, from, to, from, to, from, to, `%${from}%`, `%${from}%`, `%${from}%`, `%${from}%`, `%${from}%`]
      );
    } catch {}
  }
}

function ensureBlogInitialized(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = initializeBlog().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const { slug, id } = req.query;
      if (slug) {
        const [rows]: any = await pool.query(
          'SELECT * FROM blog_posts WHERE slug = ? AND status = "published" AND active = 1 LIMIT 1',
          [slug]
        );
        return res.status(200).json(rows[0] || null);
      }
      if (id) {
        const [rows]: any = await pool.query('SELECT * FROM blog_posts WHERE id = ? LIMIT 1', [id]);
        return res.status(200).json(rows[0] || null);
      }
      const { session } = await getAdminSession(req);
      const isAdmin = !!session;
      const listSql = isAdmin
        ? 'SELECT * FROM blog_posts ORDER BY created_at DESC'
        : 'SELECT * FROM blog_posts WHERE active = 1 AND (status = "published" OR status IS NULL) ORDER BY created_at DESC';
      const [rows]: any = await pool.query(listSql);
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    const session = await requireAdmin(req, res);
    if (!session) return;

    await ensureBlogInitialized();

    if (req.method === 'POST') {
      const { title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const safeFeaturedImage = resolveBlogFeaturedImage(featured_image);
      const finalCanonical = resolveBlogCanonical(canonical_url, slug);
      const safeContent = sanitizeRichHtml(content || '');
      const [result]: any = await pool.query(
        'INSERT INTO blog_posts (title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [title, slug || '', excerpt || '', safeContent, category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', safeFeaturedImage, meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null]
      );
      return res.status(200).json({ success: true, id: result.insertId });
    }

    if (req.method === 'PUT') {
      const { id, title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const safeFeaturedImage = resolveBlogFeaturedImage(featured_image);
      const finalCanonical = resolveBlogCanonical(canonical_url, slug);
      const safeContent = sanitizeRichHtml(content || '');
      await pool.query(
        'UPDATE blog_posts SET title=?, slug=?, excerpt=?, content=?, category=?, emoji=?, badge=?, badgeText=?, featured_image=?, meta_title=?, meta_description=?, focus_keyword=?, status=?, featured=?, canonical_url=?, faqs=? WHERE id=?',
        [title, slug || '', excerpt || '', safeContent, category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', safeFeaturedImage, meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null, id]
      );
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      await pool.query('DELETE FROM blog_posts WHERE id = ?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    if (error instanceof UrlValidationError) {
      return res.status(400).json({ error: 'Invalid URL or path' });
    }
    return res.status(500).json({ error: error.message });
  }
}
