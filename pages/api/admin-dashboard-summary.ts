import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import {
  LOW_STOCK_CONTENT_KEY,
  LOW_STOCK_DEFAULT,
  aggregateTopProducts,
  bucketCancelReason,
  capTrendPoints,
  formatPendingAge,
  parseOrderItemsJson,
  resolveLowStockThreshold,
  type ParsedLineItem,
  type TrendPoint,
} from "../../lib/dashboardExtras";

/**
 * ADMIN-DASH-01/02 — server-side dashboard aggregates (GET only).
 * Roles: super_admin | manager (explicit). Writers get 403.
 * Filter is by orders.created_at ("by order date"); there is no delivered_at.
 * Extras (DASH-02) are additive; existing summary keys stay unchanged.
 */

type Preset = "today" | "7d" | "30d" | "this_month" | "all" | "custom";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function karachiParts(d = new Date()): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/** Karachi calendar midnight as a MySQL-friendly UTC DATETIME string. */
function karachiMidnightUtcSql(y: number, m: number, day: number): string {
  // Asia/Karachi is fixed UTC+5 (no DST).
  const utcMs = Date.UTC(y, m - 1, day, 0, 0, 0) - 5 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

function addDays(y: number, m: number, day: number, delta: number): { y: number; m: number; day: number } {
  const dt = new Date(Date.UTC(y, m - 1, day + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function daysBetween(a: { y: number; m: number; day: number }, b: { y: number; m: number; day: number }): number {
  const aMs = Date.UTC(a.y, a.m - 1, a.day);
  const bMs = Date.UTC(b.y, b.m - 1, b.day);
  return Math.round((bMs - aMs) / 86400000);
}

function parseIsoDate(v: unknown): { y: number; m: number; day: number } | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  const [ys, ms, ds] = v.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const day = Number(ds);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(day)) return null;
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== day) return null;
  return { y, m, day };
}

function resolveRange(req: NextApiRequest):
  | { ok: true; preset: Preset; fromSql: string | null; toExclusiveSql: string | null; from: string | null; to: string | null }
  | { ok: false; status: number; error: string } {
  const rawPreset = String(req.query.preset || "all").trim().toLowerCase();
  const allowed: Preset[] = ["today", "7d", "30d", "this_month", "all", "custom"];
  if (!(allowed as string[]).includes(rawPreset)) {
    return { ok: false, status: 400, error: "Invalid date range" };
  }
  const preset = rawPreset as Preset;
  const today = karachiParts();

  if (preset === "all") {
    return { ok: true, preset, fromSql: null, toExclusiveSql: null, from: null, to: null };
  }

  let start = today;
  let endExclusive = addDays(today.y, today.m, today.day, 1);

  if (preset === "today") {
    start = today;
  } else if (preset === "7d") {
    start = addDays(today.y, today.m, today.day, -6);
  } else if (preset === "30d") {
    start = addDays(today.y, today.m, today.day, -29);
  } else if (preset === "this_month") {
    start = { y: today.y, m: today.m, day: 1 };
  } else if (preset === "custom") {
    const from = parseIsoDate(req.query.from);
    const to = parseIsoDate(req.query.to);
    if (!from || !to) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    if (daysBetween(from, to) < 0) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    start = from;
    endExclusive = addDays(to.y, to.m, to.day, 1);
  }

  const fromStr = `${String(start.y).padStart(4, "0")}-${String(start.m).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`;
  const toInclusive = addDays(endExclusive.y, endExclusive.m, endExclusive.day, -1);
  const toStr = `${String(toInclusive.y).padStart(4, "0")}-${String(toInclusive.m).padStart(2, "0")}-${String(toInclusive.day).padStart(2, "0")}`;

  return {
    ok: true,
    preset,
    fromSql: karachiMidnightUtcSql(start.y, start.m, start.day),
    toExclusiveSql: karachiMidnightUtcSql(endExclusive.y, endExclusive.m, endExclusive.day),
    from: fromStr,
    to: toStr,
  };
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function orderDateClause(alias: string, fromSql: string | null, toExclusiveSql: string | null): { sql: string; params: string[] } {
  if (fromSql && toExclusiveSql) {
    return {
      sql: ` ${alias}.created_at >= ? AND ${alias}.created_at < ? `,
      params: [fromSql, toExclusiveSql],
    };
  }
  return { sql: " 1=1 ", params: [] };
}

async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [table, column]
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function loadRevenueTrend(
  preset: Preset,
  fromSql: string | null,
  toExclusiveSql: string | null
): Promise<{ bucket: "day" | "month"; points: TrendPoint[] }> {
  const bucket: "day" | "month" = preset === "all" ? "month" : "day";
  // PKT = UTC+5: shift created_at before grouping.
  const keyExpr =
    bucket === "month"
      ? `DATE_FORMAT(DATE_ADD(created_at, INTERVAL 5 HOUR), '%Y-%m')`
      : `DATE_FORMAT(DATE_ADD(created_at, INTERVAL 5 HOUR), '%Y-%m-%d')`;
  const date = orderDateClause("o", fromSql, toExclusiveSql);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${keyExpr} AS bucket_key,
            COALESCE(SUM(total), 0) AS incl,
            COALESCE(SUM(total - COALESCE(vat_amount, 0)), 0) AS excl
     FROM orders o
     WHERE o.status = 'delivered' AND ${date.sql}
     GROUP BY bucket_key
     ORDER BY bucket_key ASC`,
    date.params
  );
  const points: TrendPoint[] = (Array.isArray(rows) ? rows : []).map((r) => {
    const key = String(r.bucket_key || "");
    return { key, label: key, incl: n(r.incl), excl: n(r.excl) };
  });
  return { bucket, points: capTrendPoints(points) };
}

async function loadTopProducts(
  fromSql: string | null,
  toExclusiveSql: string | null
): Promise<{ by_units: ReturnType<typeof aggregateTopProducts>["by_units"]; by_revenue: ReturnType<typeof aggregateTopProducts>["by_revenue"] }> {
  const date = orderDateClause("o", fromSql, toExclusiveSql);
  const hasItemsCol = await columnExists("orders", "items");
  const skip = new Set<string>();
  const lines: ParsedLineItem[] = [];
  const handled = new Set<string>();

  if (hasItemsCol) {
    const [ordRows] = await pool.query<RowDataPacket[]>(
      `SELECT o.order_id, o.items
       FROM orders o
       WHERE o.status = 'delivered' AND ${date.sql}`,
      date.params
    );
    for (const row of Array.isArray(ordRows) ? ordRows : []) {
      const oid = String(row.order_id || "");
      if (!oid) continue;
      if (row.items === null || row.items === undefined || row.items === "") {
        continue; // fall through to order_items
      }
      const parsed = parseOrderItemsJson(row.items);
      if (parsed === null) {
        skip.add(oid);
        continue;
      }
      handled.add(oid);
      for (const p of parsed) lines.push(p);
    }
  }

  const [itemRows] = await pool.query<RowDataPacket[]>(
    `SELECT o.order_id, oi.product_id, oi.product_name, oi.price, oi.quantity
     FROM orders o
     INNER JOIN order_items oi ON oi.order_id = o.order_id
     WHERE o.status = 'delivered' AND ${date.sql}`,
    date.params
  );
  for (const row of Array.isArray(itemRows) ? itemRows : []) {
    const oid = String(row.order_id || "");
    if (!oid || skip.has(oid) || handled.has(oid)) continue;
    const name = String(row.product_name || "").trim();
    if (!name) continue;
    const units = n(row.quantity);
    const price = n(row.price);
    lines.push({
      product_id: row.product_id == null ? null : n(row.product_id),
      name,
      units,
      revenue: units * price,
    });
  }

  return aggregateTopProducts(lines);
}

async function loadLowStock(): Promise<{
  threshold: number;
  count: number;
  products: { id: number; name: string; stock_quantity: number }[];
}> {
  let threshold = LOW_STOCK_DEFAULT;
  try {
    const [cRows] = await pool.query<RowDataPacket[]>(
      `SELECT content_value FROM site_content WHERE content_key = ? LIMIT 1`,
      [LOW_STOCK_CONTENT_KEY]
    );
    const raw = Array.isArray(cRows) && cRows[0] ? cRows[0].content_value : null;
    threshold = resolveLowStockThreshold(raw);
  } catch {
    threshold = LOW_STOCK_DEFAULT;
  }

  try {
    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM products
       WHERE track_inventory = 1
         AND (active = 1 OR active IS NULL)
         AND stock_quantity IS NOT NULL
         AND stock_quantity <= ?`,
      [threshold]
    );
    const count = n(Array.isArray(countRows) ? countRows[0]?.c : 0);
    const [listRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, stock_quantity FROM products
       WHERE track_inventory = 1
         AND (active = 1 OR active IS NULL)
         AND stock_quantity IS NOT NULL
         AND stock_quantity <= ?
       ORDER BY stock_quantity ASC, id ASC
       LIMIT 10`,
      [threshold]
    );
    const products = (Array.isArray(listRows) ? listRows : []).map((r) => ({
      id: n(r.id),
      name: String(r.name || ""),
      stock_quantity: n(r.stock_quantity),
    }));
    return { threshold, count, products };
  } catch {
    return { threshold, count: 0, products: [] };
  }
}

async function loadCancelReasons(
  fromSql: string | null,
  toExclusiveSql: string | null
): Promise<{ reason: string; count: number }[]> {
  const hasCol = await columnExists("orders", "cancel_reason");
  if (!hasCol) return [];
  const date = orderDateClause("o", fromSql, toExclusiveSql);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT cancel_reason FROM orders o
     WHERE o.status = 'cancelled' AND ${date.sql}`,
    date.params
  );
  const counts = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = bucketCancelReason(row.cancel_reason);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

async function loadPaymentSplit(
  fromSql: string | null,
  toExclusiveSql: string | null
): Promise<{ method: string; count: number; total: number }[]> {
  const date = orderDateClause("o", fromSql, toExclusiveSql);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(payment_method), ''), 'unknown') AS method,
            COUNT(*) AS cnt,
            COALESCE(SUM(total), 0) AS total
     FROM orders o
     WHERE o.status <> 'cancelled' AND ${date.sql}
     GROUP BY method
     ORDER BY cnt DESC, method ASC`,
    date.params
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    method: String(r.method || "unknown"),
    count: n(r.cnt),
    total: n(r.total),
  }));
}

async function loadOldestPending(): Promise<
  { order_id: string; age_hours: number; age_label: string; total: number; created_at: string }[]
> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT order_id, total, created_at
     FROM orders
     WHERE status = 'pending'
     ORDER BY created_at ASC, id ASC
     LIMIT 5`
  );
  const now = new Date();
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const created = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
    const age = formatPendingAge(created, now);
    return {
      order_id: String(r.order_id || ""),
      age_hours: age.age_hours,
      age_label: age.age_label,
      total: n(r.total),
      created_at: created.toISOString(),
    };
  });
}

async function loadCouponUsage(
  fromSql: string | null,
  toExclusiveSql: string | null
): Promise<{ code: string; orders: number; discount_total: number }[]> {
  const date = orderDateClause("o", fromSql, toExclusiveSql);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT UPPER(TRIM(coupon_code)) AS code,
            COUNT(*) AS orders,
            COALESCE(SUM(COALESCE(discount_amount, 0)), 0) AS discount_total
     FROM orders o
     WHERE coupon_code IS NOT NULL AND TRIM(coupon_code) <> '' AND ${date.sql}
     GROUP BY code
     ORDER BY orders DESC, code ASC`,
    date.params
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    code: String(r.code || ""),
    orders: n(r.orders),
    discount_total: n(r.discount_total),
  }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Explicit server-side RBAC (finding 7): writers must not see order/revenue aggregates.
  const session = await requirePermission(req, res, "dashboard:view");
  if (!session) return;

  try {
    const range = resolveRange(req);
    if (!range.ok) {
      return res.status(range.status).json({ error: range.error });
    }

    const dateWhere =
      range.fromSql && range.toExclusiveSql
        ? " WHERE created_at >= ? AND created_at < ? "
        : "";
    const dateParams =
      range.fromSql && range.toExclusiveSql ? [range.fromSql, range.toExclusiveSql] : [];

    const [aggRows] = await pool.query<RowDataPacket[]>(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_orders,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN 1 ELSE 0 END), 0) AS confirmed_sales_count,

        COALESCE(SUM(CASE WHEN status = 'pending' THEN total ELSE 0 END), 0) AS pending_incl,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS pending_excl,

        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN total ELSE 0 END), 0) AS confirmed_incl,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS confirmed_excl,
        COALESCE(SUM(CASE WHEN status IN ('confirmed','dispatched','delivered') THEN COALESCE(vat_amount, 0) ELSE 0 END), 0) AS tax_on_confirmed,

        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total ELSE 0 END), 0) AS revenue_incl,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS revenue_excl,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN COALESCE(vat_amount, 0) ELSE 0 END), 0) AS tax_on_revenue,

        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total ELSE 0 END), 0) AS cancelled_incl,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total - COALESCE(vat_amount, 0) ELSE 0 END), 0) AS cancelled_excl,

        COALESCE(SUM(CASE WHEN vat_amount IS NULL THEN 1 ELSE 0 END), 0) AS vat_null_orders
      FROM orders
      ${dateWhere}`,
      dateParams
    );
    const agg = Array.isArray(aggRows) ? aggRows[0] : null;

    const [custRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS customer_count FROM (
         SELECT customer_email FROM orders
         ${dateWhere ? dateWhere + " AND " : " WHERE "}
           customer_email IS NOT NULL AND customer_email != ''
         GROUP BY customer_email
       ) t`,
      dateParams
    );
    const cust = Array.isArray(custRows) ? custRows[0] : null;

    let product_count = 0;
    try {
      const [pRows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS c FROM products WHERE active = 1 OR active IS NULL"
      );
      product_count = n((Array.isArray(pRows) ? pRows[0] : null)?.c || 0);
    } catch {
      product_count = 0;
    }

    const [revenue_trend, top_products, low_stock, cancel_reasons, payment_methods, oldest_pending, coupon_usage] =
      await Promise.all([
        loadRevenueTrend(range.preset, range.fromSql, range.toExclusiveSql),
        loadTopProducts(range.fromSql, range.toExclusiveSql),
        loadLowStock(),
        loadCancelReasons(range.fromSql, range.toExclusiveSql),
        loadPaymentSplit(range.fromSql, range.toExclusiveSql),
        loadOldestPending(),
        loadCouponUsage(range.fromSql, range.toExclusiveSql),
      ]);

    return res.status(200).json({
      success: true,
      range: {
        preset: range.preset,
        from: range.from,
        to: range.to,
        label: "by order date",
        timezone: "Asia/Karachi",
      },
      total_orders: n(agg?.total_orders),
      pending_orders: n(agg?.pending_orders),
      pending_value: { incl: n(agg?.pending_incl), excl: n(agg?.pending_excl) },
      confirmed_sales: {
        incl: n(agg?.confirmed_incl),
        excl: n(agg?.confirmed_excl),
        count: n(agg?.confirmed_sales_count),
      },
      revenue: {
        incl: n(agg?.revenue_incl),
        excl: n(agg?.revenue_excl),
        count: n(agg?.delivered_orders),
      },
      tax_collected: {
        on_revenue: n(agg?.tax_on_revenue),
        on_confirmed: n(agg?.tax_on_confirmed),
      },
      cancelled_orders: n(agg?.cancelled_orders),
      cancelled_value: { incl: n(agg?.cancelled_incl), excl: n(agg?.cancelled_excl) },
      customer_count: n(cust?.customer_count),
      product_count,
      delivered_orders: n(agg?.delivered_orders),
      vat_null_orders: n(agg?.vat_null_orders),
      // ADMIN-DASH-02 extras (additive)
      revenue_trend,
      top_products,
      low_stock,
      cancel_reasons,
      payment_methods,
      oldest_pending,
      coupon_usage,
    });
  } catch (err) {
    toSafeError(err);
    return res.status(500).json({ error: "Could not load dashboard summary" });
  }
}

/**
 * Log an error CODE only — never the message, stack, SQL or row data (may contain PII).
 * Prefers a short driver/system code (e.g. ER_BAD_FIELD_ERROR, ECONNREFUSED); else the error class name.
 */
function toSafeError(err: unknown): void {
  let code = "UNKNOWN";
  const raw = (err as { code?: unknown } | null)?.code;
  if (typeof raw === "string" && /^[A-Z0-9_]{2,40}$/.test(raw)) {
    code = raw;
  } else if (err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name)) {
    code = err.name;
  }
  console.error("DASHBOARD_SUMMARY_ERROR", code);
}
