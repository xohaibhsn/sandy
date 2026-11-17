import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { formatPktDateTime, pktTodayYmdString } from "../../lib/pktDateRange";
import {
  EXPORT_MAX,
  buildOrderWhere,
  csvEscapeCell,
  itemsMetaForOrderIds,
  parseOrderListQuery,
  taxLabelsForOrderIds,
} from "../../lib/adminOrdersQuery";

function setNoStore(res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
}

function rowToCsv(cols: unknown[]): string {
  return cols.map(csvEscapeCell).join(",");
}

/**
 * GET /api/admin-orders-export
 * Same filters as list (not paginated). Hard cap EXPORT_MAX (10_000).
 * When truncated: first data comment header notes truncation; footer repeats it.
 * UTF-8 BOM for Excel. CSV injection defense via csvEscapeCell.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setNoStore(res);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await requirePermission(req, res, "orders:export");
  if (!session) return;

  try {
    const parsed = parseOrderListQuery(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { filters } = parsed;
    const { sql: whereSql, params } = buildOrderWhere(filters, "o");

    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM orders o ${whereSql}`,
      params
    );
    const total = Number((Array.isArray(countRows) ? countRows[0] : null)?.total || 0);
    const truncated = total > EXPORT_MAX;
    const fetchLimit = Math.min(total, EXPORT_MAX);

    const [idRows] = await pool.query<RowDataPacket[]>(
      `SELECT o.order_id
       FROM orders o
       ${whereSql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ?`,
      [...params, fetchLimit]
    );
    const orderIds = (Array.isArray(idRows) ? idRows : []).map((r) => String(r.order_id));

    let orders: Array<Record<string, unknown>> = [];
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
          tax_label: labels[id] || "Tax",
        };
      });
    }

    const header = [
      "order_id",
      "created_at_pkt",
      "customer_name",
      "customer_email",
      "customer_phone",
      "city",
      "payment_method",
      "status",
      "items",
      "discount_amount",
      "tax_label",
      "tax_amount",
      "total",
      "coupon_code",
      "cancel_reason",
    ];

    const lines: string[] = [];
    if (truncated) {
      lines.push(
        `# TRUNCATED: matched ${total} rows; export capped at ${EXPORT_MAX}`
      );
    }
    lines.push(rowToCsv(header));

    for (const o of orders) {
      lines.push(
        rowToCsv([
          o.order_id,
          formatPktDateTime(o.created_at),
          o.customer_name,
          o.customer_email,
          o.customer_phone,
          o.city,
          o.payment_method,
          o.status,
          o.items_list,
          o.discount_amount,
          o.tax_label || "Tax",
          o.vat_amount,
          o.total,
          o.coupon_code,
          o.cancel_reason ?? "",
        ])
      );
    }

    if (truncated) {
      lines.push(
        `# TRUNCATED: exported ${orders.length} of ${total} matching rows (cap ${EXPORT_MAX})`
      );
    }

    const csv = "\uFEFF" + lines.join("\r\n");
    const pktDate = pktTodayYmdString();
    const filename = `sandy-orders-${pktDate}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (truncated) {
      res.setHeader("X-Export-Truncated", "1");
      res.setHeader("X-Export-Total", String(total));
      res.setHeader("X-Export-Cap", String(EXPORT_MAX));
    }
    return res.status(200).send(csv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || "");
    console.error("[admin-orders-export]", msg.slice(0, 200));
    return res.status(500).json({ error: "Unable to export orders" });
  }
}
