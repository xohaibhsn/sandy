import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2";
import pool from "../../lib/db";
import { requireRole } from "../../lib/adminAuth";

/**
 * ADMIN-DASH-01 — server-side dashboard aggregates (GET only).
 * Roles: super_admin | manager (explicit). Writers get 403.
 * Filter is by orders.created_at ("by order date"); there is no delivered_at.
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Explicit server-side RBAC (finding 7): writers must not see order/revenue aggregates.
  const session = await requireRole(req, res, ["super_admin", "manager"]);
  if (!session) return;
  if (session.role !== "super_admin" && session.role !== "manager") {
    return res.status(403).json({ error: "Forbidden" });
  }

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
      product_count = Number((Array.isArray(pRows) ? pRows[0] : null)?.c || 0);
    } catch {
      product_count = 0;
    }

    const n = (v: unknown) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };

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
    });
  } catch (err) {
    toSafeError(err);
    return res.status(500).json({ error: "Could not load dashboard summary" });
  }
}

function toSafeError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err || "");
  console.error("[admin-dashboard-summary]", msg.slice(0, 200));
}
