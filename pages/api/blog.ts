import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { SITE_URL } from '../../lib/site';
import { getAdminSession } from '../../lib/adminAuth';
import { hasPermission, requirePermission } from '../../lib/adminPermissions';
import { sanitizeRichHtml } from '../../lib/richHtmlSanitizer';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';
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

/*
 * The blog_posts table (including canonical_url and faqs) comes from migrations/0003-admin-schema.sql
 * (owner-run). This handler never creates or alters tables and never rewrites existing posts.
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const { slug, id } = req.query;
      if (slug) {
        const [rows] = await pool.query<RowDataPacket[]>(
          'SELECT * FROM blog_posts WHERE slug = ? AND status = "published" AND active = 1 LIMIT 1',
          [slug]
        );
        return res.status(200).json(rows[0] || null);
      }
      // Soft check only: GET never returns 401/403. Only blog:write sessions see unpublished rows.
      const { session } = await getAdminSession(req);
      const canSeeDrafts = !!session && hasPermission(session.role, 'blog:write');
      if (id) {
        const idSql = canSeeDrafts
          ? 'SELECT * FROM blog_posts WHERE id = ? LIMIT 1'
          : 'SELECT * FROM blog_posts WHERE id = ? AND active = 1 AND (status = "published" OR status IS NULL) LIMIT 1';
        const [rows] = await pool.query<RowDataPacket[]>(idSql, [id]);
        return res.status(200).json(rows[0] || null);
      }
      const listSql = canSeeDrafts
        ? 'SELECT * FROM blog_posts ORDER BY created_at DESC'
        : 'SELECT * FROM blog_posts WHERE active = 1 AND (status = "published" OR status IS NULL) ORDER BY created_at DESC';
      const [rows] = await pool.query<RowDataPacket[]>(listSql);
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    const session = await requirePermission(req, res, 'blog:write');
    if (!session) return;


    if (req.method === 'POST') {
      const { title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const safeFeaturedImage = resolveBlogFeaturedImage(featured_image);
      const finalCanonical = resolveBlogCanonical(canonical_url, slug);
      const safeContent = sanitizeRichHtml(content || '');
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO blog_posts (title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [title, slug || '', excerpt || '', safeContent, category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', safeFeaturedImage, meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null]
      );
      await recordAudit(pool, {
        actor: session,
        action: 'create',
        entityType: 'blog_post',
        entityId: result.insertId,
        summary: `Created blog post "${String(title || '').slice(0, 120)}"`,
        detail: {
          title,
          slug: slug || '',
          category: category || 'Guides',
          status: status || 'published',
          featured: featured ? 1 : 0,
          content: safeContent,
        },
        req,
      });
      return res.status(200).json({ success: true, id: result.insertId });
    }

    if (req.method === 'PUT') {
      const { id, title, slug, excerpt, content, category, emoji, badge, badgeText, featured_image, meta_title, meta_description, focus_keyword, status, featured, canonical_url, faqs } = req.body;
      const safeFeaturedImage = resolveBlogFeaturedImage(featured_image);
      const finalCanonical = resolveBlogCanonical(canonical_url, slug);
      const safeContent = sanitizeRichHtml(content || '');
      const [beforeRows] = await pool.query<RowDataPacket[]>(
        'SELECT title, slug, excerpt, content, category, status, featured, canonical_url, featured_image, meta_title, meta_description, focus_keyword FROM blog_posts WHERE id = ? LIMIT 1',
        [id]
      );
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query(
        'UPDATE blog_posts SET title=?, slug=?, excerpt=?, content=?, category=?, emoji=?, badge=?, badgeText=?, featured_image=?, meta_title=?, meta_description=?, focus_keyword=?, status=?, featured=?, canonical_url=?, faqs=? WHERE id=?',
        [title, slug || '', excerpt || '', safeContent, category || 'Guides', emoji || '📝', badge || 'guide', badgeText || 'Guide', safeFeaturedImage, meta_title || '', meta_description || '', focus_keyword || '', status || 'published', featured ? 1 : 0, finalCanonical, faqs ? JSON.stringify(faqs) : null, id]
      );
      if (before) {
        await recordAudit(pool, {
          actor: session,
          action: 'update',
          entityType: 'blog_post',
          entityId: id,
          summary: `Updated blog post "${String(title || '').slice(0, 120)}"`,
          detail: {
            changes: auditFieldDiff(
              { ...before, featured: Number(before.featured) ? 1 : 0 },
              {
                title,
                slug: slug || '',
                excerpt: excerpt || '',
                content: safeContent,
                category: category || 'Guides',
                status: status || 'published',
                featured: featured ? 1 : 0,
                canonical_url: finalCanonical,
                featured_image: safeFeaturedImage,
                meta_title: meta_title || '',
                meta_description: meta_description || '',
                focus_keyword: focus_keyword || '',
              }
            ),
          },
          req,
        });
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      const [beforeRows] = await pool.query<RowDataPacket[]>('SELECT title, slug FROM blog_posts WHERE id = ? LIMIT 1', [id]);
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query('DELETE FROM blog_posts WHERE id = ?', [id]);
      if (before) {
        await recordAudit(pool, {
          actor: session,
          action: 'delete',
          entityType: 'blog_post',
          entityId: String(id),
          summary: `Deleted blog post "${String(before.title ?? id).slice(0, 120)}"`,
          detail: { title: before.title, slug: before.slug },
          req,
        });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: unknown) {
    if (error instanceof UrlValidationError) {
      return res.status(400).json({ error: 'Invalid URL or path' });
    }
    console.error('[api/blog] request failed', (error as { code?: unknown } | null | undefined)?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
