import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../../../lib/db";
import { requireAccountCustomer } from "../../../../lib/accountApi";

const LIST_LIMIT = 100;

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Ownership: stamped to this customer, or an unlinked guest order placed with the same verified phone.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT o.order_id, o.status, o.total, o.created_at, o.payment_method,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.order_id) AS item_count
       FROM orders o
       WHERE (o.customer_id = ? OR (o.customer_id IS NULL AND o.customer_phone_norm = ?))
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ${LIST_LIMIT}`,
      [me.id, me.phone_norm]
    );

    const orders = (Array.isArray(rows) ? rows : []).map((r) => ({
      order_id: String(r.order_id),
      status: r.status != null ? String(r.status) : null,
      total: r.total,
      created_at: r.created_at,
      payment_method: r.payment_method != null ? String(r.payment_method) : null,
      item_count: Number(r.item_count) || 0,
    }));
    return res.status(200).json({ orders });
  } catch (err) {
    if (isMissingColumnError(err)) {
      console.error("[api/account/orders] failed", "MISSING_COLUMN");
      return res.status(503).json({ error: "Service unavailable" });
    }
    console.error("[api/account/orders] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
