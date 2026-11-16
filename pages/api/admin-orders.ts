import type { NextApiRequest, NextApiResponse } from 'next';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import pool from '../../lib/db';
import { ensureShopTables } from '../../lib/ensureShopTables';
import { requireAdmin } from '../../lib/adminAuth';
import {
  CANCEL_COLUMN_MISSING,
  CANCEL_COLUMN_MISSING_MESSAGE,
  composeCancelReason,
  hasCancelReasonColumn,
} from '../../lib/orderCancel';

const ALLOWED_STATUSES = [
  'pending',
  'confirmed',
  'dispatched',
  'delivered',
  'cancelled',
] as const;

type OrderLockRow = RowDataPacket & {
  order_id: string;
  status: string;
  coupon_code: string | null;
};

type OrderItemRow = RowDataPacket & {
  product_id: number | null;
  quantity: number;
};

async function cancelOrderWithRollback(
  orderId: string,
  cancelReason: string
): Promise<
  | { ok: true; already_cancelled: boolean }
  | { ok: false; status: number; error: string; code?: string }
> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.query<OrderLockRow[]>(
      `SELECT order_id, status, coupon_code
       FROM orders
       WHERE order_id = ?
       LIMIT 1
       FOR UPDATE`,
      [orderId]
    );

    if (!Array.isArray(orderRows) || orderRows.length === 0) {
      await connection.rollback();
      return { ok: false, status: 404, error: 'Order not found' };
    }

    const order = orderRows[0];
    if (String(order.status) === 'cancelled') {
      await connection.commit();
      return { ok: true, already_cancelled: true };
    }

    const [itemRows] = await connection.query<OrderItemRow[]>(
      `SELECT product_id, quantity
       FROM order_items
       WHERE order_id = ?`,
      [orderId]
    );

    for (const item of Array.isArray(itemRows) ? itemRows : []) {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity);
      if (!Number.isFinite(productId) || productId <= 0) continue;
      if (!Number.isFinite(qty) || qty <= 0) continue;

      // Restore only tracked inventory; missing/untracked products → 0 rows, OK.
      await connection.query(
        `UPDATE products
         SET stock = CAST(stock_quantity + ? AS CHAR),
             stock_quantity = stock_quantity + ?
         WHERE id = ?
           AND track_inventory = 1
           AND stock_quantity IS NOT NULL`,
        [qty, qty, productId]
      );
    }

    const couponCode =
      typeof order.coupon_code === 'string' ? order.coupon_code.trim() : '';
    if (couponCode) {
      await connection.query(
        `UPDATE coupons
         SET used_count = GREATEST(used_count - 1, 0)
         WHERE code = ?`,
        [couponCode]
      );
    }

    const [updateResult] = await connection.query<ResultSetHeader>(
      `UPDATE orders
       SET status = 'cancelled', cancel_reason = ?
       WHERE order_id = ?`,
      [cancelReason, orderId]
    );

    if (!updateResult || Number(updateResult.affectedRows) === 0) {
      await connection.rollback();
      return { ok: false, status: 404, error: 'Order not found' };
    }

    await connection.commit();
    return { ok: true, already_cancelled: false };
  } catch {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    return { ok: false, status: 500, error: 'Unable to cancel order' };
  } finally {
    connection.release();
  }
}

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
      // o.* naturally includes cancel_reason only when the column exists.
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
      const body = req.body ?? {};
      const { order_id, status, cancel_reason_code, cancel_reason_note } = body;

      if (typeof order_id !== 'string' || !order_id.trim()) {
        return res.status(400).json({ error: 'Valid order_id is required' });
      }
      if (
        typeof status !== 'string' ||
        !(ALLOWED_STATUSES as readonly string[]).includes(status)
      ) {
        return res.status(400).json({ error: 'Invalid order status' });
      }

      const trimmedId = order_id.trim();

      // Reject any transition out of cancelled (terminal).
      const [currentRows] = await pool.query<OrderLockRow[]>(
        `SELECT order_id, status, coupon_code FROM orders WHERE order_id = ? LIMIT 1`,
        [trimmedId]
      );
      if (!Array.isArray(currentRows) || currentRows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const currentStatus = String(currentRows[0].status || '');
      if (currentStatus === 'cancelled' && status !== 'cancelled') {
        return res.status(409).json({
          error: 'Cancelled orders cannot change status',
        });
      }

      if (status !== 'cancelled') {
        // Non-cancel transitions: behave exactly as before (ignore reason fields).
        const [result] = await pool.query(
          'UPDATE orders SET status = ? WHERE order_id = ?',
          [status, trimmedId]
        );
        if (!result || Number((result as ResultSetHeader).affectedRows) === 0) {
          return res.status(404).json({ error: 'Order not found' });
        }
        return res.status(200).json({
          success: true,
          order_id: trimmedId,
          status,
        });
      }

      // status === 'cancelled'
      const columnPresent = await hasCancelReasonColumn(pool);
      if (!columnPresent) {
        return res.status(409).json({
          error: CANCEL_COLUMN_MISSING_MESSAGE,
          code: CANCEL_COLUMN_MISSING,
        });
      }

      const composed = composeCancelReason(
        cancel_reason_code,
        cancel_reason_note
      );
      if (!composed.ok) {
        return res.status(400).json({ error: composed.error });
      }

      // Idempotent re-cancel of an already-cancelled order (with column present).
      if (currentStatus === 'cancelled') {
        return res.status(200).json({
          success: true,
          order_id: trimmedId,
          status: 'cancelled',
          already_cancelled: true,
        });
      }

      const outcome = await cancelOrderWithRollback(trimmedId, composed.reason);
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }

      return res.status(200).json({
        success: true,
        order_id: trimmedId,
        status: 'cancelled',
        already_cancelled: outcome.already_cancelled,
      });
    }

    if (req.method === 'DELETE') {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ error: 'order_id required' });

      // Fetch order before deleting (for response summary)
      const [orderRows]: any = await pool.query(
        'SELECT * FROM orders WHERE order_id=?',
        [order_id]
      );
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
