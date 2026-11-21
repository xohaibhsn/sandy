import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../lib/db";
import { requirePermission, type AdminPermission } from "../../lib/adminPermissions";
import type { AdminSession } from "../../lib/adminAuth";
import { recordAudit } from "../../lib/auditLog";
import {
  CANCEL_COLUMN_MISSING,
  CANCEL_COLUMN_MISSING_MESSAGE,
  composeCancelReason,
  hasCancelReasonColumn,
} from "../../lib/orderCancel";
import { assertSafeReceiptUrl } from "../../lib/urlValidation";
import { parseReceiptRef, staffReceiptProxyPath } from "../../lib/receiptRef";
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
import { RISK_REASON_LABELS, type RiskReasonCode } from "../../lib/codRisk";
import { loadOrderProtectionSettings } from "../../lib/orderProtectionSettings";
import { normaliseEmail, normalisePhone } from "../../lib/customerIdentity";
import { loadShippingSettings } from "../../lib/shippingSettings";
import { hasDeliveryOpsOrderColumns, hasShippingOrderColumns } from "../../lib/shippingSchema";
import { TRACKING_NUMBER_RE, buildTrackingUrl } from "../../lib/shipping";
import { assertStatusTransition, isPickupOrder } from "../../lib/shippingStatus";

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

/** Preset reason stored on cancel_reason when an order comes back undelivered (RTO). */
const RTO_CANCEL_REASON = "Returned to origin (RTO)";

async function cancelOrderWithRollback(
  orderId: string,
  cancelReason: string,
  options: { rto?: boolean; audit?: { session: AdminSession; req: NextApiRequest } } = {}
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
    if (options.rto && String(order.status) !== "dispatched") {
      // RTO only applies to orders that actually left the warehouse (and never twice).
      await connection.rollback();
      return { ok: false, status: 409, error: "Only dispatched orders can be marked as returned to origin" };
    }
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

    if (options.rto) {
      // Same transaction as the restock / coupon / cancel above: all or nothing.
      await connection.query(
        `UPDATE orders SET rto = 1, rto_at = NOW() WHERE order_id = ?`,
        [orderId]
      );
    }

    if (options.audit) {
      // Audit INSIDE the transaction (before commit) so a rollback drops the audit row too.
      await recordAudit(connection, {
        actor: options.audit.session,
        action: options.rto ? "rto" : "cancel",
        entityType: "order",
        entityId: orderId,
        summary: options.rto
          ? `Order ${orderId} marked returned to origin (RTO)`
          : `Order ${orderId} cancelled`,
        detail: {
          order_id: orderId,
          from_status: String(order.status),
          to_status: "cancelled",
          cancel_reason: cancelReason,
          item_lines: Array.isArray(itemRows) ? itemRows.length : 0,
          coupon_rolled_back: !!couponCode,
        },
        req: options.audit.req,
      });
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

  const customers = Array.isArray(rows) ? rows : [];
  const phoneNorms = customers
    .map((c) => normalisePhone(c.customer_phone))
    .filter((v): v is string => Boolean(v));
  const emailNorms = customers
    .map((c) => normaliseEmail(c.customer_email))
    .filter((v): v is string => Boolean(v));

  const blockedSet = new Set<string>();
  if (phoneNorms.length || emailNorms.length) {
    try {
      const clauses: string[] = [];
      const bParams: string[] = [];
      if (phoneNorms.length) {
        clauses.push(`phone_norm IN (${phoneNorms.map(() => "?").join(",")})`);
        bParams.push(...phoneNorms);
      }
      if (emailNorms.length) {
        clauses.push(`email_norm IN (${emailNorms.map(() => "?").join(",")})`);
        bParams.push(...emailNorms);
      }
      const [bl] = await pool.query<RowDataPacket[]>(
        `SELECT phone_norm, email_norm FROM customer_blacklist
         WHERE active = 1 AND (${clauses.join(" OR ")})`,
        bParams
      );
      for (const row of bl || []) {
        if (row.phone_norm) blockedSet.add(`p:${row.phone_norm}`);
        if (row.email_norm) blockedSet.add(`e:${row.email_norm}`);
      }
    } catch {
      /* table may be absent before migration */
    }
  }

  const enriched = customers.map((c) => {
    const pn = normalisePhone(c.customer_phone);
    const en = normaliseEmail(c.customer_email);
    const blocked =
      (pn != null && blockedSet.has(`p:${pn}`)) ||
      (en != null && blockedSet.has(`e:${en}`));
    return { ...c, blocked };
  });

  return res.status(200).json({
    success: true,
    customers: enriched,
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

  const orderIdStr = String(order.order_id || "");
  let receipt_url: string | null = null;
  const rawReceipt = order.receipt_path;
  if (rawReceipt != null && String(rawReceipt).trim()) {
    const raw = String(rawReceipt).trim();
    const ref = parseReceiptRef(raw);
    if (ref) {
      try {
        receipt_url = staffReceiptProxyPath(orderIdStr, ref.ext, "receipt");
      } catch {
        receipt_url = null;
      }
    } else {
      try {
        receipt_url = assertSafeReceiptUrl(raw);
        if (!receipt_url) receipt_url = null;
      } catch {
        receipt_url = null;
      }
    }
  }

  let advance_receipt_url: string | null = null;
  let advance_receipt_path: string | boolean | null = order.advance_receipt_path ?? null;
  if (advance_receipt_path != null && String(advance_receipt_path).trim()) {
    const rawAdv = String(advance_receipt_path).trim();
    const advRef = parseReceiptRef(rawAdv);
    if (advRef) {
      try {
        advance_receipt_url = staffReceiptProxyPath(orderIdStr, advRef.ext, "advance");
      } catch {
        advance_receipt_url = null;
      }
      // Never return the opaque ref as a usable path to the browser.
      advance_receipt_path = true;
    } else {
      try {
        const safeAdv = assertSafeReceiptUrl(rawAdv);
        advance_receipt_url = safeAdv || null;
        advance_receipt_path = safeAdv || null;
      } catch {
        advance_receipt_url = null;
        advance_receipt_path = null;
      }
    }
  } else {
    advance_receipt_path = null;
  }

  const reasonCodes = String(order.risk_reasons || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as RiskReasonCode[];
  const risk_reason_labels = reasonCodes.map(
    (code) => RISK_REASON_LABELS[code] || code
  );

  // Shipping / courier / RTO (migration 0009). `SELECT *` already carries the columns when they
  // exist, so their presence on the row is the probe; nothing is added to the response otherwise.
  let shippingFields: Record<string, unknown> = {};
  // Delivery ops (migration 0010, BATCH-17): same probe. Keys are added only when the order actually
  // carries delivery-ops data or shipping is enabled, so a flags-off store keeps the ab26978 key set.
  const opsOnRow =
    "fulfilment" in order && "shipping_area" in order && "rider_id" in order && "pickup_point_id" in order;
  if ("shipping_amount" in order && "courier_id" in order) {
    let courierName: string | null = null;
    let trackingUrl: string | null = null;
    if (order.courier_id != null) {
      try {
        const [courierRows] = await pool.query<RowDataPacket[]>(
          `SELECT name, tracking_url_template FROM couriers WHERE id = ? LIMIT 1`,
          [order.courier_id]
        );
        const c = Array.isArray(courierRows) ? courierRows[0] : undefined;
        if (c) {
          courierName = c.name != null ? String(c.name) : null;
          trackingUrl = buildTrackingUrl(c.tracking_url_template, order.tracking_number);
        }
      } catch {
        /* couriers table absent: leave name/link empty */
      }
    }
    let couriers: Array<{ id: number; name: string }> = [];
    try {
      const [activeRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, name FROM couriers WHERE active = 1 ORDER BY sort_order ASC, id ASC`
      );
      couriers = (Array.isArray(activeRows) ? activeRows : []).map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? ""),
      }));
    } catch {
      couriers = [];
    }
    shippingFields = {
      shipping_amount: order.shipping_amount ?? null,
      shipping_zone: order.shipping_zone ?? null,
      courier_id: order.courier_id ?? null,
      courier_name: courierName,
      tracking_number: order.tracking_number ?? null,
      tracking_url: trackingUrl,
      shipped_at: order.shipped_at ?? null,
      delivered_at: order.delivered_at ?? null,
      rto: order.rto == null ? null : Number(order.rto) === 1,
      rto_at: order.rto_at ?? null,
      couriers,
    };

    const hasOpsData =
      opsOnRow &&
      (order.fulfilment != null ||
        order.shipping_area != null ||
        order.rider_id != null ||
        order.pickup_point_id != null);
    const opsShippingOn = opsOnRow ? (await loadShippingSettings()).shipping_enabled : false;
    if (opsOnRow && (hasOpsData || opsShippingOn)) {
      let riderName: string | null = null;
      let pickupInfo: { address: string | null; hours_text: string | null; map_url: string | null } | null = null;
      if (order.rider_id != null) {
        try {
          const [riderRows] = await pool.query<RowDataPacket[]>(
            `SELECT name FROM riders WHERE id = ? LIMIT 1`,
            [order.rider_id]
          );
          const r = Array.isArray(riderRows) ? riderRows[0] : undefined;
          riderName = r && r.name != null ? String(r.name) : null;
        } catch {
          riderName = null;
        }
      }
      if (order.pickup_point_id != null) {
        try {
          const [pointRows] = await pool.query<RowDataPacket[]>(
            `SELECT address, hours_text, map_url FROM pickup_points WHERE id = ? LIMIT 1`,
            [order.pickup_point_id]
          );
          const p = Array.isArray(pointRows) ? pointRows[0] : undefined;
          if (p) {
            pickupInfo = {
              address: p.address != null ? String(p.address) : null,
              hours_text: p.hours_text != null ? String(p.hours_text) : null,
              map_url: p.map_url != null ? String(p.map_url) : null,
            };
          }
        } catch {
          pickupInfo = null;
        }
      }
      let riders: Array<{ id: number; name: string }> = [];
      if (opsShippingOn) {
        try {
          const [riderRows] = await pool.query<RowDataPacket[]>(
            `SELECT id, name FROM riders WHERE active = 1 ORDER BY sort_order ASC, id ASC`
          );
          riders = (Array.isArray(riderRows) ? riderRows : []).map((r) => ({
            id: Number(r.id),
            name: String(r.name ?? ""),
          }));
        } catch {
          riders = [];
        }
      }
      shippingFields = {
        ...shippingFields,
        fulfilment: isPickupOrder(order.fulfilment) ? "pickup" : "delivery",
        shipping_area: order.shipping_area ?? null,
        rider_id: order.rider_id ?? null,
        rider_name: riderName,
        pickup_point_id: order.pickup_point_id ?? null,
        pickup_point_name: order.pickup_point_name ?? null,
        pickup_point_address: pickupInfo?.address ?? null,
        pickup_point_hours: pickupInfo?.hours_text ?? null,
        pickup_point_map_url: pickupInfo?.map_url ?? null,
        riders,
      };
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
      risk_score: order.risk_score ?? null,
      risk_reasons: reasonCodes,
      risk_reason_labels,
      otp_verified: order.otp_verified == null ? null : Number(order.otp_verified) === 1,
      confirmation_method: order.confirmation_method ?? null,
      confirmation_note: order.confirmation_note ?? null,
      confirmed_by: order.confirmed_by ?? null,
      confirmed_at: order.confirmed_at ?? null,
      advance_amount: order.advance_amount ?? null,
      advance_reference: order.advance_reference ?? null,
      advance_receipt_path,
      advance_receipt_url,
      ...shippingFields,
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
    else if (s === "ready_for_pickup") status_counts.ready_for_pickup = Number(row.c || 0);
  }
  // BATCH-17: the ready_for_pickup bucket appears only when pickup is on or such orders exist
  // (a flags-off store keeps the ab26978 status_counts key set).
  if (!("ready_for_pickup" in status_counts) && (await loadShippingSettings()).pickup_enabled) {
    status_counts.ready_for_pickup = 0;
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

      // Returned to origin (BATCH-12): dispatched order -> existing cancel transaction (restock,
      // coupon rollback, cancelled status) + rto = 1 / rto_at = NOW() in the SAME transaction.
      if (body.action === "rto") {
        const rtoOrderId = order_id.trim();
        if (!(await hasCancelReasonColumn(pool))) {
          return res.status(409).json({
            error: CANCEL_COLUMN_MISSING_MESSAGE,
            code: CANCEL_COLUMN_MISSING,
          });
        }
        if (!(await hasShippingOrderColumns(pool))) {
          return res.status(409).json({
            error: "Marking returns needs a one-time database update (shipping columns). Ask the owner to apply it.",
            code: "RTO_COLUMN_MISSING",
          });
        }
        if (await hasDeliveryOpsOrderColumns(pool)) {
          // BATCH-17: pickup orders never ship, so they can never be returned to origin.
          const [fulfilmentRows] = await pool.query<RowDataPacket[]>(
            `SELECT fulfilment FROM orders WHERE order_id = ? LIMIT 1`,
            [rtoOrderId]
          );
          const rtoCheck = assertStatusTransition({
            fulfilment: Array.isArray(fulfilmentRows) ? fulfilmentRows[0]?.fulfilment : null,
            from: "dispatched",
            to: "cancelled",
            action: "rto",
          });
          if (!rtoCheck.ok) {
            return res.status(rtoCheck.status).json({ error: rtoCheck.error, code: rtoCheck.code });
          }
        }
        const rtoOutcome = await cancelOrderWithRollback(rtoOrderId, RTO_CANCEL_REASON, {
          rto: true,
          audit: { session, req },
        });
        if (!rtoOutcome.ok) {
          return res.status(rtoOutcome.status).json({ error: rtoOutcome.error });
        }
        return res.status(200).json({
          success: true,
          order_id: rtoOrderId,
          status: "cancelled",
          rto: true,
        });
      }

      if (
        typeof status !== "string" ||
        !(ALLOWED_STATUSES as readonly string[]).includes(status)
      ) {
        return res.status(400).json({ error: "Invalid order status" });
      }

      const trimmedId = order_id.trim();
      const protection = await loadOrderProtectionSettings();

      // BATCH-17: ready_for_pickup is only a valid target once migration 0010 exists; before that the
      // value stays "Invalid order status" exactly as at ab26978.
      const opsOrderCols = await hasDeliveryOpsOrderColumns(pool);
      if (status === "ready_for_pickup" && !opsOrderCols) {
        return res.status(400).json({ error: "Invalid order status" });
      }
      const fulfilmentSelect = opsOrderCols ? ", fulfilment" : "";

      type CurrentOrderRow = OrderLockRow & {
        payment_method?: string | null;
        confirmed_at?: Date | string | null;
        fulfilment?: string | null;
      };
      let currentRows: CurrentOrderRow[];
      try {
        if (protection.cod_protection_enabled) {
          const [rows] = await pool.query<CurrentOrderRow[]>(
            `SELECT order_id, status, coupon_code, payment_method, confirmed_at${fulfilmentSelect}
             FROM orders WHERE order_id = ? LIMIT 1`,
            [trimmedId]
          );
          currentRows = Array.isArray(rows) ? rows : [];
        } else {
          const [rows] = await pool.query<CurrentOrderRow[]>(
            `SELECT order_id, status, coupon_code${fulfilmentSelect} FROM orders WHERE order_id = ? LIMIT 1`,
            [trimmedId]
          );
          currentRows = Array.isArray(rows) ? rows : [];
        }
      } catch (selErr) {
        // Missing protection columns while flag somehow on → fail closed.
        safeLog(selErr);
        return res.status(503).json({ error: "Service unavailable" });
      }
      if (!Array.isArray(currentRows) || currentRows.length === 0) {
        return res.status(404).json({ error: "Order not found" });
      }
      const current = currentRows[0];
      const currentStatus = String(current.status || "");
      const paymentMethod = String(current.payment_method || "");
      if (currentStatus === "cancelled" && status !== "cancelled") {
        return res.status(409).json({
          error: "Cancelled orders cannot change status",
        });
      }

      if (status !== "cancelled") {
        // BATCH-17: pickup orders cannot be dispatched; delivery orders cannot be ready_for_pickup.
        const transition = assertStatusTransition({
          fulfilment: current.fulfilment,
          from: currentStatus,
          to: status,
        });
        if (!transition.ok) {
          return res.status(transition.status).json({ error: transition.error, code: transition.code });
        }

        // COD pickup: pending -> ready_for_pickup also needs the COD confirmation first.
        if (
          protection.cod_protection_enabled &&
          paymentMethod === "cod" &&
          status === "ready_for_pickup" &&
          !current.confirmed_at &&
          currentStatus !== "confirmed" &&
          currentStatus !== "ready_for_pickup" &&
          currentStatus !== "delivered"
        ) {
          return res.status(409).json({
            error: "Confirm this COD order before it is ready for pickup",
            code: "COD_CONFIRMATION_REQUIRED",
          });
        }

        // COD confirmation gate when protection enabled.
        if (
          protection.cod_protection_enabled &&
          paymentMethod === "cod" &&
          status === "confirmed"
        ) {
          const method = body.confirmation_method;
          if (method !== "call" && method !== "whatsapp") {
            return res.status(400).json({ error: "confirmation_method required" });
          }
          const note =
            typeof body.confirmation_note === "string"
              ? body.confirmation_note.trim().slice(0, 500)
              : "";
          const confirmedBy = String(session.name || session.role || "admin").slice(0, 255);
          const connection = await pool.getConnection();
          try {
            await connection.beginTransaction();
            const [locked] = await connection.query<RowDataPacket[]>(
              `SELECT order_id, status, payment_method, confirmed_at
               FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE`,
              [trimmedId]
            );
            const row = Array.isArray(locked) ? locked[0] : undefined;
            if (!row) {
              await connection.rollback();
              return res.status(404).json({ error: "Order not found" });
            }
            if (String(row.status) === "cancelled") {
              await connection.rollback();
              return res.status(409).json({ error: "Cancelled orders cannot change status" });
            }
            if (String(row.payment_method) !== "cod") {
              await connection.rollback();
              return res.status(409).json({ error: "Invalid request" });
            }
            const [result] = await connection.query<ResultSetHeader>(
              `UPDATE orders
               SET status = 'confirmed',
                   confirmation_method = ?,
                   confirmation_note = ?,
                   confirmed_by = ?,
                   confirmed_at = NOW()
               WHERE order_id = ? AND status <> 'cancelled'`,
              [method, note || null, confirmedBy, trimmedId]
            );
            if (!result || Number(result.affectedRows) === 0) {
              await connection.rollback();
              return res.status(409).json({ error: "Unable to confirm order" });
            }
            // Audit INSIDE the transaction (before commit) so a rollback drops the audit row too.
            await recordAudit(connection, {
              actor: session,
              action: "confirm",
              entityType: "order",
              entityId: trimmedId,
              summary: `COD order ${trimmedId} confirmed by ${method}`,
              detail: {
                order_id: trimmedId,
                from_status: String(row.status),
                to_status: "confirmed",
                confirmation_method: method,
                note_length: note.length,
              },
              req,
            });
            await connection.commit();
            return res.status(200).json({
              success: true,
              order_id: trimmedId,
              status: "confirmed",
            });
          } catch (err) {
            try {
              await connection.rollback();
            } catch {
              /* ignore */
            }
            safeLog(err);
            return res.status(500).json({ error: "Server error" });
          } finally {
            connection.release();
          }
        }

        if (
          protection.cod_protection_enabled &&
          paymentMethod === "cod" &&
          status === "dispatched" &&
          !current.confirmed_at &&
          currentStatus !== "confirmed" &&
          currentStatus !== "dispatched" &&
          currentStatus !== "delivered"
        ) {
          return res.status(409).json({
            error: "Confirm this COD order before dispatch",
            code: "COD_CONFIRMATION_REQUIRED",
          });
        }

        // pending → dispatched for COD refused unless already confirmed
        if (
          protection.cod_protection_enabled &&
          paymentMethod === "cod" &&
          status === "dispatched" &&
          currentStatus === "pending" &&
          !current.confirmed_at
        ) {
          return res.status(409).json({
            error: "Confirm this COD order before dispatch",
            code: "COD_CONFIRMATION_REQUIRED",
          });
        }

        // Flag off (or any other status): the original single-column UPDATE, unchanged.
        let updateSql = "UPDATE orders SET status = ? WHERE order_id = ? AND status <> 'cancelled'";
        let updateParams: unknown[] = [status, trimmedId];
        // Non-secret dispatch context for the audit row (courier / rider ids, tracking number).
        const auditExtra: Record<string, unknown> = {};

        if (status === "dispatched" || status === "delivered") {
          const shippingOn = (await loadShippingSettings()).shipping_enabled;
          if (shippingOn) {
            if (!(await hasShippingOrderColumns(pool))) {
              return res.status(503).json({ error: "Service unavailable" });
            }
            const sets: string[] = ["status = ?"];
            const setParams: unknown[] = [status];

            if (status === "dispatched") {
              // Timestamp is write-once: COALESCE keeps the first dispatch time.
              sets.push("shipped_at = COALESCE(shipped_at, NOW())");

              const rawCourier = body.courier_id;
              if (rawCourier !== undefined && rawCourier !== null && rawCourier !== "") {
                const courierId = typeof rawCourier === "number" ? rawCourier : Number(String(rawCourier).trim());
                if (!Number.isInteger(courierId) || courierId <= 0) {
                  return res.status(400).json({ error: "Invalid courier" });
                }
                let courierOk = false;
                try {
                  const [courierRows] = await pool.query<RowDataPacket[]>(
                    "SELECT id FROM couriers WHERE id = ? AND active = 1 LIMIT 1",
                    [courierId]
                  );
                  courierOk = Array.isArray(courierRows) && courierRows.length > 0;
                } catch {
                  return res.status(503).json({ error: "Service unavailable" });
                }
                if (!courierOk) return res.status(400).json({ error: "Invalid courier" });
                sets.push("courier_id = ?");
                setParams.push(courierId);
                auditExtra.courier_id = courierId;
              }

              const rawTracking = body.tracking_number;
              if (rawTracking !== undefined && rawTracking !== null && rawTracking !== "") {
                if (typeof rawTracking !== "string" || !TRACKING_NUMBER_RE.test(rawTracking.trim())) {
                  return res.status(400).json({ error: "Invalid tracking number" });
                }
                sets.push("tracking_number = ?");
                setParams.push(rawTracking.trim());
                auditExtra.tracking_number = rawTracking.trim();
              }

              // Own-rider dispatch (BATCH-17): optional active rider; tracking stays optional.
              const rawRider = body.rider_id;
              if (rawRider !== undefined && rawRider !== null && rawRider !== "") {
                const riderId = typeof rawRider === "number" ? rawRider : Number(String(rawRider).trim());
                if (!Number.isInteger(riderId) || riderId <= 0) {
                  return res.status(400).json({ error: "Invalid rider" });
                }
                if (!opsOrderCols) {
                  return res.status(503).json({ error: "Service unavailable" });
                }
                let riderOk = false;
                try {
                  const [riderRows] = await pool.query<RowDataPacket[]>(
                    "SELECT id FROM riders WHERE id = ? AND active = 1 LIMIT 1",
                    [riderId]
                  );
                  riderOk = Array.isArray(riderRows) && riderRows.length > 0;
                } catch {
                  return res.status(503).json({ error: "Service unavailable" });
                }
                if (!riderOk) return res.status(400).json({ error: "Invalid rider" });
                sets.push("rider_id = ?");
                setParams.push(riderId);
                auditExtra.rider_id = riderId;
              }
            } else {
              sets.push("delivered_at = COALESCE(delivered_at, NOW())");
            }

            updateSql = `UPDATE orders SET ${sets.join(", ")} WHERE order_id = ? AND status <> 'cancelled'`;
            updateParams = [...setParams, trimmedId];
          }
        }

        const [result] = await pool.query(updateSql, updateParams);
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
        } else {
          await recordAudit(pool, {
            actor: session,
            action:
              status === "dispatched"
                ? "dispatch"
                : status === "confirmed"
                  ? "confirm"
                  : "status_change",
            entityType: "order",
            entityId: trimmedId,
            summary: `Order ${trimmedId} status ${currentStatus || "?"} -> ${status}`,
            detail: {
              order_id: trimmedId,
              from_status: currentStatus,
              to_status: status,
              ...auditExtra,
            },
            req,
          });
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

      const outcome = await cancelOrderWithRollback(trimmedId, composed.reason, {
        audit: { session, req },
      });
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

      await recordAudit(pool, {
        actor: session,
        action: "delete",
        entityType: "order",
        entityId: String(order_id),
        summary: `Order ${String(order_id).slice(0, 64)} deleted`,
        detail: {
          order_id: String(order_id),
          was_status: order.status,
          total: Number(order.total || 0),
          payment_method: order.payment_method ?? null,
        },
        req,
      });

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
