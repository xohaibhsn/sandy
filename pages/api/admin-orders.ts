import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../lib/db";
import { requirePermission, type AdminPermission } from "../../lib/adminPermissions";
import {
  CANCEL_COLUMN_MISSING,
  CANCEL_COLUMN_MISSING_MESSAGE,
  composeCancelReason,
  hasCancelReasonColumn,
} from "../../lib/orderCancel";
import { assertSafeReceiptUrl } from "../../lib/urlValidation";
import { formatPktDateTime } from "../../lib/pktDateRange";
import {
  ORDER_STATUSES,
  PAGE_SIZES,
  buildOrderWhere,
  clampInt,
  escapeLikeWildcards,
  itemsMetaForOrderIds,
  parseOrderListQuery,
  taxLabelsForOrderIds,
  SEARCH_MAX,
  SEARCH_MIN,
} from "../../lib/adminOrdersQuery";

const ALLOWED_STATUSES = ORDER_STATUSES;

type OrderLockRow = RowDataPacket & {
  order_id: string;
  status: string;
  coupon_code: string | null;
};

type OrderItemRow = RowDataPacket & {
  product_id: number | null;
  quantity: number;
};

function setNoStore(res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
}

function safeLog(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || "");
  console.error("[admin-orders]", msg.slice(0, 200));
}

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
      return { ok: false, status: 404, error: "Order not found" };
    }

    const order = orderRows[0];
    if (String(order.status) === "cancelled") {
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
      typeof order.coupon_code === "string" ? order.coupon_code.trim() : "";
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
      return { ok: false, status: 404, error: "Order not found" };
    }

    await connection.commit();
    return { ok: true, already_cancelled: false };
  } catch {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    return { ok: false, status: 500, error: "Unable to cancel order" };
  } finally {
    connection.release();
  }
}

async function handleBadge(res: NextApiResponse) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'`
  );
  const pending_count = Number((Array.isArray(rows) ? rows[0] : null)?.c || 0);
  return res.status(200).json({ success: true, pending_count });
}

async function handleRecent(req: NextApiRequest, res: NextApiResponse) {
  const limit = clampInt(req.query.limit, 1, 20, 5);
  const [idRows] = await pool.query<RowDataPacket[]>(
    `SELECT order_id FROM orders
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [limit]
  );
  const orderIds = (Array.isArray(idRows) ? idRows : []).map((r) => String(r.order_id));
  if (!orderIds.length) {
    return res.status(200).json({ success: true, orders: [] });
  }
  const placeholders = orderIds.map(() => "?").join(",");
  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM orders WHERE order_id IN (${placeholders})`,
    orderIds
  );
  const byId: Record<string, RowDataPacket> = {};
  for (const row of Array.isArray(orderRows) ? orderRows : []) {
    byId[String(row.order_id)] = row;
  }
  const itemsMap = await itemsMetaForOrderIds(pool, orderIds);
  const labels = await taxLabelsForOrderIds(pool, orderIds);
  const orders = orderIds.map((id) => {
    const o = byId[id] || { order_id: id };
    const meta = itemsMap[id] || { items_list: "", items_count: 0 };
    return {
      ...o,
      items_list: meta.items_list,
      items_count: meta.items_count,
      tax_label: labels[id] || "Tax",
    };
  });
  return res.status(200).json({ success: true, orders });
}

async function handleCustomers(req: NextApiRequest, res: NextApiResponse) {
  const page = clampInt(req.query.page, 1, 1_000_000, 1);
  const rawSize = clampInt(req.query.pageSize ?? req.query.limit, 1, 100, 25);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : -1;
  if (pageSize < 0) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const qRaw = String(req.query.q || "").trim();
  if (qRaw && (qRaw.length < SEARCH_MIN || qRaw.length > SEARCH_MAX)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (qRaw) {
    const like = `%${escapeLikeWildcards(qRaw)}%`;
    where.push(
      `(customer_name LIKE ? ESCAPE '\\\\' OR customer_email LIKE ? ESCAPE '\\\\' OR customer_phone LIKE ? ESCAPE '\\\\')`
    );
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM (
       SELECT customer_email
       FROM orders
       ${whereSql}
       GROUP BY customer_email, customer_name, customer_phone
     ) t`,
    params
  );
  const total = Number((Array.isArray(countRows) ? countRows[0] : null)?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const offset = (page - 1) * pageSize;

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT customer_name, customer_email, customer_phone,
            COUNT(*) AS order_count,
            COALESCE(SUM(total), 0) AS total_spent,
            MIN(created_at) AS first_order,
            MAX(created_at) AS last_order
     FROM orders
     ${whereSql}
     GROUP BY customer_email, customer_name, customer_phone
     ORDER BY last_order DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return res.status(200).json({
    success: true,
    customers: Array.isArray(rows) ? rows : [],
    total,
    page,
    pageSize,
    totalPages,
  });
}

async function handleDetail(res: NextApiResponse, orderId: string) {
  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
    [orderId]
  );
  const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null;
  if (!order) {
    return res.status(404).json({ error: "Not found" });
  }

  const [itemRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, product_id, product_name, price, quantity,
            (price * quantity) AS line_total
     FROM order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [orderId]
  );
  const items = Array.isArray(itemRows) ? itemRows : [];

  let tax: {
    label: string;
    vat_amount: number;
    lines: unknown[] | null;
    has_snapshot: boolean;
  } = {
    label: "Tax",
    vat_amount: Number(order.vat_amount || 0),
    lines: null,
    has_snapshot: false,
  };

  try {
    const [snapRows] = await pool.query<RowDataPacket[]>(
      `SELECT tax_label, vat_amount, snapshot_json
       FROM order_tax_snapshots
       WHERE order_id = ?
       LIMIT 1`,
      [orderId]
    );
    const snap = Array.isArray(snapRows) ? snapRows[0] : null;
    if (snap) {
      let lines: unknown[] | null = null;
      try {
        const parsed =
          typeof snap.snapshot_json === "string"
            ? JSON.parse(snap.snapshot_json)
            : snap.snapshot_json;
        if (parsed && typeof parsed === "object") {
          const maybeLines = (parsed as { lines?: unknown }).lines;
          if (Array.isArray(maybeLines)) lines = maybeLines;
          else if (Array.isArray(parsed)) lines = parsed;
        }
      } catch {
        lines = null;
      }
      tax = {
        label:
          typeof snap.tax_label === "string" && snap.tax_label.trim()
            ? snap.tax_label.trim()
            : "Tax",
        vat_amount: Number(snap.vat_amount ?? order.vat_amount ?? 0),
        lines,
        has_snapshot: true,
      };
    }
  } catch {
    /* legacy / missing table */
  }

  let receipt_url: string | null = null;
  const rawReceipt = order.receipt_path;
  if (rawReceipt != null && String(rawReceipt).trim()) {
    try {
      receipt_url = assertSafeReceiptUrl(String(rawReceipt));
      if (!receipt_url) receipt_url = null;
    } catch {
      receipt_url = null;
    }
  }

  return res.status(200).json({
    success: true,
    order: {
      order_id: order.order_id,
      status: order.status,
      customer_name: order.customer_name,
      customer_email: order.customer_email,
      customer_phone: order.customer_phone,
      delivery_address: order.delivery_address,
      city: order.city,
      postcode: order.postcode,
      payment_method: order.payment_method,
      payment_reference: order.payment_reference,
      discount_amount: order.discount_amount,
      coupon_code: order.coupon_code,
      vat_amount: order.vat_amount,
      total: order.total,
      notes: order.notes,
      cancel_reason: order.cancel_reason ?? null,
      created_at: order.created_at,
      created_at_pkt: formatPktDateTime(order.created_at),
      receipt_url,
    },
    items,
    tax,
  });
}

async function handleList(req: NextApiRequest, res: NextApiResponse) {
  const parsed = parseOrderListQuery(req.query);
  if (!parsed.ok) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const { filters, page, pageSize } = parsed;
  const { sql: whereSql, params } = buildOrderWhere(filters, "o");

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM orders o ${whereSql}`,
    params
  );
  const total = Number((Array.isArray(countRows) ? countRows[0] : null)?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const [statusRows] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS c FROM orders o ${whereSql} GROUP BY status`,
    params
  );
  const status_counts: Record<string, number> = {
    pending: 0,
    confirmed: 0,
    dispatched: 0,
    delivered: 0,
    cancelled: 0,
  };
  for (const row of Array.isArray(statusRows) ? statusRows : []) {
    const s = String(row.status || "");
    if (s in status_counts) status_counts[s] = Number(row.c || 0);
  }

  const [idRows] = await pool.query<RowDataPacket[]>(
    `SELECT o.order_id
     FROM orders o
     ${whereSql}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const orderIds = (Array.isArray(idRows) ? idRows : []).map((r) => String(r.order_id));

  let orders: Record<string, unknown>[] = [];
  if (orderIds.length) {
    const placeholders = orderIds.map(() => "?").join(",");
    const [orderRows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM orders WHERE order_id IN (${placeholders})`,
      orderIds
    );
    const byId: Record<string, RowDataPacket> = {};
    for (const row of Array.isArray(orderRows) ? orderRows : []) {
      byId[String(row.order_id)] = row;
    }
    const itemsMap = await itemsMetaForOrderIds(pool, orderIds);
    const labels = await taxLabelsForOrderIds(pool, orderIds);
    orders = orderIds.map((id) => {
      const o = byId[id] || { order_id: id };
      const meta = itemsMap[id] || { items_list: "", items_count: 0 };
      return {
        ...o,
        items_list: meta.items_list,
        items_count: meta.items_count,
        tax_label: labels[id] || "Tax",
      };
    });
  }

  return res.status(200).json({
    success: true,
    orders,
    total,
    page: safePage,
    pageSize,
    totalPages,
    status_counts,
    filters: {
      q: filters.q,
      status: filters.status || "all",
      payment_method: filters.paymentMethod || "all",
      preset: filters.preset,
      from: filters.from,
      to: filters.to,
    },
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setNoStore(res);

  // Central RBAC (P3b). Permission depends on method/variant; unknown methods fall back to
  // orders:view so auth/role ordering (401 -> 403 -> 405) is unchanged.
  const method = String(req.method || "").toUpperCase();
  const permission: AdminPermission =
    method === "PATCH"
      ? "orders:update"
      : method === "DELETE"
        ? "orders:delete"
        : method === "GET" && req.query.customers === "1"
          ? "customers:view"
          : "orders:view";
  const session = await requirePermission(req, res, permission);
  if (!session) return;

  try {
    if (req.method === "GET") {
      if (req.query.badge === "1") return handleBadge(res);
      if (req.query.recent === "1") return handleRecent(req, res);
      if (req.query.customers === "1") return handleCustomers(req, res);

      const idRaw = String(req.query.id || req.query.order_id || "").trim();
      if (idRaw) {
        if (idRaw.length > 64) {
          return res.status(400).json({ error: "Invalid request" });
        }
        return handleDetail(res, idRaw);
      }

      return handleList(req, res);
    }

    if (req.method === "PATCH") {
      const body = req.body ?? {};
      const { order_id, status, cancel_reason_code, cancel_reason_note } = body;

      if (typeof order_id !== "string" || !order_id.trim()) {
        return res.status(400).json({ error: "Valid order_id is required" });
      }
      if (
        typeof status !== "string" ||
        !(ALLOWED_STATUSES as readonly string[]).includes(status)
      ) {
        return res.status(400).json({ error: "Invalid order status" });
      }

      const trimmedId = order_id.trim();

      const [currentRows] = await pool.query<OrderLockRow[]>(
        `SELECT order_id, status, coupon_code FROM orders WHERE order_id = ? LIMIT 1`,
        [trimmedId]
      );
      if (!Array.isArray(currentRows) || currentRows.length === 0) {
        return res.status(404).json({ error: "Order not found" });
      }
      const currentStatus = String(currentRows[0].status || "");
      if (currentStatus === "cancelled" && status !== "cancelled") {
        return res.status(409).json({
          error: "Cancelled orders cannot change status",
        });
      }

      if (status !== "cancelled") {
        const [result] = await pool.query(
          "UPDATE orders SET status = ? WHERE order_id = ? AND status <> 'cancelled'",
          [status, trimmedId]
        );
        if (!result || Number((result as ResultSetHeader).affectedRows) === 0) {
          const [again] = await pool.query<OrderLockRow[]>(
            `SELECT order_id, status FROM orders WHERE order_id = ? LIMIT 1`,
            [trimmedId]
          );
          if (!Array.isArray(again) || again.length === 0) {
            return res.status(404).json({ error: "Order not found" });
          }
          if (String(again[0].status) === "cancelled") {
            return res.status(409).json({
              error: "Cancelled orders cannot change status",
            });
          }
        }
        return res.status(200).json({
          success: true,
          order_id: trimmedId,
          status,
        });
      }

      const columnPresent = await hasCancelReasonColumn(pool);
      if (!columnPresent) {
        return res.status(409).json({
          error: CANCEL_COLUMN_MISSING_MESSAGE,
          code: CANCEL_COLUMN_MISSING,
        });
      }

      const composed = composeCancelReason(cancel_reason_code, cancel_reason_note);
      if (!composed.ok) {
        return res.status(400).json({ error: composed.error });
      }

      if (currentStatus === "cancelled") {
        return res.status(200).json({
          success: true,
          order_id: trimmedId,
          status: "cancelled",
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
        status: "cancelled",
        already_cancelled: outcome.already_cancelled,
      });
    }

    if (req.method === "DELETE") {
      const { order_id } = req.body ?? {};
      if (!order_id) return res.status(400).json({ error: "order_id required" });

      const [orderRows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM orders WHERE order_id=?",
        [order_id]
      );
      if (!Array.isArray(orderRows) || !orderRows.length) {
        return res.status(404).json({ error: "Order not found" });
      }
      const order = orderRows[0];

      await pool.query("DELETE FROM order_items WHERE order_id=?", [order_id]);
      await pool.query("DELETE FROM orders WHERE order_id=?", [order_id]);

      return res.status(200).json({
        success: true,
        deleted_order_id: order_id,
        reversed_amount: Number(order.total || 0),
        was_status: order.status,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error: unknown) {
    safeLog(error);
    return res.status(500).json({ error: "Unable to process request" });
  }
}
