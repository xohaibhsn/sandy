import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getAdminSession } from '../../lib/adminAuth';
import { requirePermission } from '../../lib/adminPermissions';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';



/*
 * The faqs table and the default FAQ rows come from migrations/0003 and 0004 (owner-run).
 * This handler never creates tables, seeds rows or deletes FAQs on its own.
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const { admin } = req.query;
      let query = 'SELECT * FROM faqs';
      if (admin) {
        const { session } = await getAdminSession(req);
        if (!session) query += ' WHERE is_visible=1';
      } else {
        query += ' WHERE is_visible=1';
      }
      query += ' ORDER BY category, sort_order ASC';
      const [rows] = await pool.query(query);
      return res.status(200).json(Array.isArray(rows)?rows:[]);
    }

    const session = await requirePermission(req, res, 'faqs:write');
    if (!session) return;


    if (req.method === 'POST') {
      const { question, answer, category, sort_order } = req.body;
      if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
      const [r]: any = await pool.query(
        'INSERT INTO faqs (question,answer,category,sort_order) VALUES (?,?,?,?)',
        [question, answer, category||'General', sort_order||0]
      );
      await recordAudit(pool, {
        actor: session,
        action: 'create',
        entityType: 'faq',
        entityId: r.insertId,
        summary: `Created FAQ "${String(question).slice(0, 120)}"`,
        detail: { question, answer, category: category||'General', sort_order: sort_order||0 },
        req,
      });
      return res.status(200).json({ success:true, id:r.insertId });
    }

    if (req.method === 'PUT') {
      const { id, question, answer, category, sort_order, is_visible } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required' });
      const [beforeRows]: any = await pool.query(
        'SELECT question,answer,category,sort_order,is_visible FROM faqs WHERE id=? LIMIT 1',
        [id]
      );
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query(
        'UPDATE faqs SET question=?,answer=?,category=?,sort_order=?,is_visible=? WHERE id=?',
        [question, answer, category||'General', sort_order||0, is_visible??1, id]
      );
      if (before) {
        await recordAudit(pool, {
          actor: session,
          action: 'update',
          entityType: 'faq',
          entityId: id,
          summary: `Updated FAQ #${String(id).slice(0, 20)}`,
          detail: {
            changes: auditFieldDiff(
              { ...before, sort_order: Number(before.sort_order), is_visible: Number(before.is_visible) },
              { question, answer, category: category||'General', sort_order: Number(sort_order||0), is_visible: Number(is_visible??1) }
            ),
          },
          req,
        });
      }
      return res.status(200).json({ success:true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      const [beforeRows]: any = await pool.query('SELECT question FROM faqs WHERE id=? LIMIT 1', [id]);
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
      await pool.query('DELETE FROM faqs WHERE id=?', [id]);
      if (before) {
        await recordAudit(pool, {
          actor: session,
          action: 'delete',
          entityType: 'faq',
          entityId: String(id),
          summary: `Deleted FAQ "${String(before.question ?? id).slice(0, 120)}"`,
          detail: { question: before.question },
          req,
        });
      }
      return res.status(200).json({ success:true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('[api/faqs] request failed', error?.code || 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
