import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { ensureShopTables } from '../../lib/ensureShopTables';
import { requireAdmin } from '../../lib/adminAuth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAdmin(req, res);
  if (!session) return;
  try {
    await ensureShopTables();
    if (req.method === 'GET') {
      if (req.query.customers === '1') {
        const [rows] = await pool.query(`
          SELECT customer_name, customer_email, customer_phone,
            COUNT(*) AS order_count,
            SUM(total) AS total_spent,
            MIN(created_at) AS first_order
          FROM orders
          GROUP BY customer_email, customer_name, customer_phone
          ORDER BY first_order DESC
        `);
        return res.status(200).json(Array.isArray(rows) ? rows : []);
      }
      const [rows] = await pool.query(`
        SELECT o.*,
          GROUP_CONCAT(oi.product_name ORDER BY oi.id SEPARATOR ' + ') AS items_list
        FROM orders o
        LEFT JOIN order_items oi ON o.order_id = oi.order_id
        GROUP BY o.order_id
        ORDER BY o.created_at DESC
      `);
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    if (req.method === 'PATCH') {
      const ALLOWED_STATUSES = ['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'] as const;
      const { order_id, status } = req.body ?? {};

      if (typeof order_id !== 'string' || !order_id.trim()) {
        return res.status(400).json({ error: 'Valid order_id is required' });
      }
      if (typeof status !== 'string' || !(ALLOWED_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: 'Invalid order status' });
      }

      const [result] = await pool.query(
        'UPDATE orders SET status = ? WHERE order_id = ?',
        [status, order_id.trim()]
      );
      if (!result || Number((result as { affectedRows?: number }).affectedRows) === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      return res.status(200).json({
        success: true,
        order_id: order_id.trim(),
        status,
      });
    }

    if (req.method === 'DELETE') {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ error: 'order_id required' });

      // Fetch order before deleting (for response summary)
      const [orderRows]: any = await pool.query('SELECT * FROM orders WHERE order_id=?', [order_id]);
      if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
      const order = orderRows[0];

      // Delete order items first (FK constraint)
      await pool.query('DELETE FROM order_items WHERE order_id=?', [order_id]);
      // Delete main order
      await pool.query('DELETE FROM orders WHERE order_id=?', [order_id]);

      return res.status(200).json({
        success: true,
        deleted_order_id: order_id,
        reversed_amount: Number(order.total || 0),
        was_status: order.status,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
