/**
 * ADMIN-DASH-02 — pure helpers for dashboard extras (no DB I/O).
 */

import { CANCEL_PRESETS } from "./orderCancel";

export const LOW_STOCK_CONTENT_KEY = "admin_low_stock_threshold";
export const LOW_STOCK_DEFAULT = 5;
export const LOW_STOCK_MAX = 9999;
export const TREND_MAX_POINTS = 90;

export type ParsedLineItem = {
  product_id: number | null;
  name: string;
  units: number;
  revenue: number;
};

export type TrendPoint = {
  key: string;
  label: string;
  incl: number;
  excl: number;
};

export type TopProductRow = {
  product_id: number | null;
  name: string;
  units: number;
  revenue: number;
};

/**
 * Validate site_content value for admin_low_stock_threshold.
 * Accepts integer 0–9999 (string or number). Rejects empty, float, out of range.
 */
export function parseLowStockThreshold(
  raw: unknown
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, error: "Invalid low stock threshold" };
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    return { ok: false, error: "Invalid low stock threshold" };
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > LOW_STOCK_MAX) {
    return { ok: false, error: "Invalid low stock threshold" };
  }
  return { ok: true, value: n };
}

/** Missing / blank → default 5. Invalid non-blank still falls back to default for reads. */
export function resolveLowStockThreshold(raw: unknown): number {
  if (raw === null || raw === undefined) return LOW_STOCK_DEFAULT;
  const s = String(raw).trim();
  if (!s) return LOW_STOCK_DEFAULT;
  const parsed = parseLowStockThreshold(s);
  return parsed.ok ? parsed.value : LOW_STOCK_DEFAULT;
}

/**
 * Parse order line-items JSON safely. Returns null if malformed (caller must skip the order).
 * Accepts array of {name|product_name, qty|quantity, price|unit_price, product_id?}.
 */
export function parseOrderItemsJson(raw: unknown): ParsedLineItem[] | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      value = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const out: ParsedLineItem[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const r = row as Record<string, unknown>;
    const nameRaw = r.name ?? r.product_name;
    if (typeof nameRaw !== "string" || !nameRaw.trim()) return null;
    const qtyRaw = r.qty ?? r.quantity;
    const priceRaw = r.price ?? r.unit_price;
    const units = Number(qtyRaw);
    const price = Number(priceRaw);
    if (!Number.isFinite(units) || units < 0 || !Number.isFinite(price)) return null;
    const pid = r.product_id;
    out.push({
      product_id: typeof pid === "number" && Number.isFinite(pid) ? pid : pid != null ? Number(pid) || null : null,
      name: nameRaw.trim(),
      units,
      revenue: units * price,
    });
  }
  return out;
}

/** Map stored cancel_reason to a preset label or "Other". */
export function bucketCancelReason(stored: unknown): string {
  if (typeof stored !== "string" || !stored.trim()) return "Other";
  const t = stored.trim();
  for (const p of CANCEL_PRESETS) {
    if (p.code === "other") continue;
    if (t === p.label) return p.label;
  }
  return "Other";
}

export function formatPendingAge(
  createdAt: Date,
  now: Date = new Date()
): { age_hours: number; age_label: string } {
  const ms = Math.max(0, now.getTime() - createdAt.getTime());
  const age_hours = Math.floor(ms / 3600000);
  if (age_hours < 48) {
    return { age_hours, age_label: `${age_hours}h` };
  }
  const days = Math.floor(age_hours / 24);
  return { age_hours, age_label: `${days}d` };
}

export function aggregateTopProducts(
  lines: ParsedLineItem[]
): { by_units: TopProductRow[]; by_revenue: TopProductRow[] } {
  const map = new Map<string, TopProductRow>();
  for (const line of lines) {
    const key = `${line.product_id ?? "x"}::${line.name}`;
    const cur = map.get(key) || {
      product_id: line.product_id,
      name: line.name,
      units: 0,
      revenue: 0,
    };
    cur.units += line.units;
    cur.revenue += line.revenue;
    map.set(key, cur);
  }
  const all = [...map.values()];
  const by_units = [...all].sort((a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name)).slice(0, 5);
  const by_revenue = [...all].sort((a, b) => b.revenue - a.revenue || b.units - a.units || a.name.localeCompare(b.name)).slice(0, 5);
  return { by_units, by_revenue };
}

/** Cap trend series to the most recent TREND_MAX_POINTS buckets. */
export function capTrendPoints(points: TrendPoint[]): TrendPoint[] {
  if (points.length <= TREND_MAX_POINTS) return points;
  return points.slice(points.length - TREND_MAX_POINTS);
}
