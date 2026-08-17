import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { SITE_URL } from '../../lib/site';

function checkAdminAuth(req: any): boolean {
  const session = req.headers['x-admin-session'] || req.cookies?.sAdminSession;
  return !!session;
}



export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'GET' && !checkAdminAuth(req)) return res.status(403).json({ error: 'Forbidden' });

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
    ]) { try { await pool.query(col); } catch (_) {} }

    // Activate any existing posts that have NULL active (added before column existed)
    try { await pool.query("UPDATE blog_posts SET active=1 WHERE active IS NULL"); } catch (_) {}

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
      } catch (_) {}
    }

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
      const [rows]: any = await pool.query('SELECT * FROM blog_posts WHERE active = 1 ORDER BY created_at DESC');
      if (Array.isArray(rows) && rows.length === 0) {
        await pool.query(`
          INSERT INTO blog_posts (title, slug, excerpt, content, category, emoji, badge, badgeText, status)
          VALUES
          ('How to Shop on Sandy', 'how-to-shop-on-sandy', 'Getting started on Sandy is easy. Browse accessories and gadgets, add them to your cart, and checkout with COD or prepaid payment.', '<h2>Getting Started</h2><p>Browse products, add items to your cart, enter your delivery details, and place your order. We deliver across Pakistan.</p>', 'Guides', '🛒', 'guide', 'Guide', 'published'),
          ('Paying on Sandy — COD, JazzCash and Bank Transfer', 'paying-on-sandy', 'Choose Cash on Delivery, JazzCash, Easypaisa or bank transfer at checkout. Account details for prepaid methods are shared after you order.', '<h2>Payment Options</h2><p>COD is the default. For JazzCash, Easypaisa or bank transfer, we share account details after you place the order.</p>', 'Tips', '💳', 'tips', 'Tips', 'published'),
          ('What''s New at Sandy', 'whats-new-at-sandy', 'We have added new products, improved order tracking, and launched nationwide delivery.', '<h2>New This Month</h2><p>Check out our improved order tracking and new product range.</p>', 'News', '🚀', 'news', 'News', 'published')
        `);
        const [fresh] = await pool.query('SELECT * FROM blog_posts WHERE active = 1 ORDER BY created_at DESC');
        return res.status(200).json(Array.isArray(fresh) ? fresh : []);
      }
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    if (req.method === 'POST') {
      const { title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const finalCanonical = (canonical_url || '').trim() || `${SITE_URL}/blog/${slug || ''}`;
      const [result]: any = await pool.query(
        'INSERT INTO blog_posts (title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [title, slug || '', excerpt || '', content || '', category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', featured_image || '', meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null]
      );
      return res.status(200).json({ success: true, id: result.insertId });
    }

    if (req.method === 'PUT') {
      const { id, title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const finalCanonical = (canonical_url || '').trim() || `${SITE_URL}/blog/${slug || ''}`;
      await pool.query(
        'UPDATE blog_posts SET title=?, slug=?, excerpt=?, content=?, category=?, emoji=?, badge=?, badgeText=?, featured_image=?, meta_title=?, meta_description=?, focus_keyword=?, status=?, featured=?, canonical_url=?, faqs=? WHERE id=?',
        [title, slug || '', excerpt || '', content || '', category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', featured_image || '', meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null, id]
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
    return res.status(500).json({ error: error.message });
  }
}
