/**
 * COD & delivery insights — pure aggregates + CSV (D78 / D79).
 * Counts and money only; no customer-identifying fields.
 */

export const COD_RTO_AMBER = 20;
export const COD_RTO_RED = 35;
export const COD_CITY_TOP_N = 25;

export type CodInsightRawRow = {
  /** Raw group label from SQL (may need normalisation). */
  key: string;
  orders: number;
  delivered: number;
  rto: number;
  cancelled: number;
  open: number;
  delivered_revenue: number;
  delivered_revenue_ex_gst: number;
};

export type CodInsightRow = {
  key: string;
  orders: number;
  delivered: number;
  rto: number;
  cancelled: number;
  open: number;
  /** Percent 0–100, one decimal; null when delivered+rto === 0. */
  rto_rate: number | null;
  /** Percent 0–100, one decimal; null when orders === 0. */
  cancel_rate: number | null;
  delivered_revenue: number;
  delivered_revenue_ex_gst: number;
};

export type CodInsightsBundle = {
  by_city: CodInsightRow[];
  by_province: CodInsightRow[];
  by_payment: CodInsightRow[];
  by_courier: CodInsightRow[];
  by_zone: CodInsightRow[];
  totals: CodInsightRow;
};

export type CodInsightsRange = {
  preset: string;
  from: string | null;
  to: string | null;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Trim + case-fold for merging city labels; empty → "". */
export function normaliseCityKey(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Display label: trimmed original; empty → fallback. */
export function displayCityLabel(raw: unknown, fallback = "Unknown"): string {
  if (raw === null || raw === undefined) return fallback;
  const t = String(raw).trim().replace(/\s+/g, " ");
  return t || fallback;
}

function roundRate(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

function withRates(row: Omit<CodInsightRow, "rto_rate" | "cancel_rate">): CodInsightRow {
  return {
    ...row,
    rto_rate: roundRate(row.rto, row.delivered + row.rto),
    cancel_rate: roundRate(row.cancelled, row.orders),
  };
}

function emptyTotals(): CodInsightRow {
  return withRates({
    key: "totals",
    orders: 0,
    delivered: 0,
    rto: 0,
    cancelled: 0,
    open: 0,
    delivered_revenue: 0,
    delivered_revenue_ex_gst: 0,
  });
}

function mergeRaw(into: CodInsightRawRow, add: CodInsightRawRow): void {
  into.orders += n(add.orders);
  into.delivered += n(add.delivered);
  into.rto += n(add.rto);
  into.cancelled += n(add.cancelled);
  into.open += n(add.open);
  into.delivered_revenue += n(add.delivered_revenue);
  into.delivered_revenue_ex_gst += n(add.delivered_revenue_ex_gst);
}

/**
 * Merge rows that share a normalised key; keep first non-empty display label.
 * Sort by orders desc, then key asc.
 */
export function mergeAndSortRows(
  rows: CodInsightRawRow[],
  opts?: { normaliseKey?: (k: string) => string; displayKey?: (raw: string, norm: string) => string }
): CodInsightRow[] {
  const normFn = opts?.normaliseKey ?? ((k: string) => k.trim().toLowerCase());
  const dispFn =
    opts?.displayKey ??
    ((raw: string) => {
      const t = raw.trim().replace(/\s+/g, " ");
      return t || "Unknown";
    });

  const map = new Map<string, CodInsightRawRow>();
  for (const row of rows) {
    const rawKey = row.key == null ? "" : String(row.key);
    const norm = normFn(rawKey) || "__empty__";
    const existing = map.get(norm);
    if (!existing) {
      map.set(norm, {
        key: dispFn(rawKey, norm === "__empty__" ? "" : norm),
        orders: n(row.orders),
        delivered: n(row.delivered),
        rto: n(row.rto),
        cancelled: n(row.cancelled),
        open: n(row.open),
        delivered_revenue: n(row.delivered_revenue),
        delivered_revenue_ex_gst: n(row.delivered_revenue_ex_gst),
      });
    } else {
      mergeRaw(existing, row);
    }
  }

  return [...map.values()]
    .map((r) =>
      withRates({
        key: r.key,
        orders: r.orders,
        delivered: r.delivered,
        rto: r.rto,
        cancelled: r.cancelled,
        open: r.open,
        delivered_revenue: r.delivered_revenue,
        delivered_revenue_ex_gst: r.delivered_revenue_ex_gst,
      })
    )
    .sort((a, b) => b.orders - a.orders || a.key.localeCompare(b.key));
}

/** Top-N by orders; remainder collapsed into "Other". */
export function topNWithOther(rows: CodInsightRow[], nTop = COD_CITY_TOP_N, otherLabel = "Other"): CodInsightRow[] {
  if (rows.length <= nTop) return rows;
  const head = rows.slice(0, nTop);
  const rest = rows.slice(nTop);
  const other = withRates({
    key: otherLabel,
    orders: rest.reduce((s, r) => s + r.orders, 0),
    delivered: rest.reduce((s, r) => s + r.delivered, 0),
    rto: rest.reduce((s, r) => s + r.rto, 0),
    cancelled: rest.reduce((s, r) => s + r.cancelled, 0),
    open: rest.reduce((s, r) => s + r.open, 0),
    delivered_revenue: rest.reduce((s, r) => s + r.delivered_revenue, 0),
    delivered_revenue_ex_gst: rest.reduce((s, r) => s + r.delivered_revenue_ex_gst, 0),
  });
  return [...head, other];
}

function sumRows(rows: CodInsightRow[]): CodInsightRow {
  const base = emptyTotals();
  for (const r of rows) {
    base.orders += r.orders;
    base.delivered += r.delivered;
    base.rto += r.rto;
    base.cancelled += r.cancelled;
    base.open += r.open;
    base.delivered_revenue += r.delivered_revenue;
    base.delivered_revenue_ex_gst += r.delivered_revenue_ex_gst;
  }
  return withRates({
    key: "totals",
    orders: base.orders,
    delivered: base.delivered,
    rto: base.rto,
    cancelled: base.cancelled,
    open: base.open,
    delivered_revenue: base.delivered_revenue,
    delivered_revenue_ex_gst: base.delivered_revenue_ex_gst,
  });
}

/**
 * Build the insights bundle from per-dimension raw SQL rows.
 * City: case/whitespace merge + top-25 + Other.
 */
export function buildCodInsights(input: {
  by_city: CodInsightRawRow[];
  by_province: CodInsightRawRow[];
  by_payment: CodInsightRawRow[];
  by_courier: CodInsightRawRow[];
  by_zone: CodInsightRawRow[];
}): CodInsightsBundle {
  const by_city = topNWithOther(
    mergeAndSortRows(input.by_city, {
      normaliseKey: (k) => normaliseCityKey(k) || "__unknown__",
      displayKey: (raw, norm) => {
        if (!norm || norm === "__unknown__") return "Unknown";
        return displayCityLabel(raw, "Unknown");
      },
    }),
    COD_CITY_TOP_N,
    "Other"
  );

  const by_province = mergeAndSortRows(input.by_province, {
    normaliseKey: (k) => k.trim().toLowerCase() || "__unknown__",
    displayKey: (raw, norm) => {
      if (!norm || norm === "__unknown__") return "Unknown";
      const t = raw.trim().replace(/\s+/g, " ");
      return t || "Unknown";
    },
  });

  const by_payment = mergeAndSortRows(input.by_payment, {
    normaliseKey: (k) => k.trim().toLowerCase() || "unknown",
    displayKey: (raw) => {
      const t = raw.trim();
      return t || "unknown";
    },
  });

  const by_courier = mergeAndSortRows(input.by_courier, {
    normaliseKey: (k) => k.trim().toLowerCase() || "not assigned",
    displayKey: (raw) => {
      const t = raw.trim();
      return t || "Not assigned";
    },
  });

  const by_zone = mergeAndSortRows(input.by_zone, {
    normaliseKey: (k) => k.trim().toLowerCase() || "no zone",
    displayKey: (raw) => {
      const t = raw.trim();
      return t || "No zone";
    },
  });

  // Totals from city rows before top-N collapse would under-count if we used by_city after Other;
  // use payment (no collapse) which covers every order once.
  const totals = sumRows(by_payment);

  return { by_city, by_province, by_payment, by_courier, by_zone, totals };
}

/** CSV-injection guard: leading = + - @ or tab → prefix apostrophe. */
export function csvGuardCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return s;
}

function csvEscape(value: unknown): string {
  const guarded = csvGuardCell(value);
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

const CSV_HEADERS = [
  "dimension",
  "key",
  "orders",
  "delivered",
  "rto",
  "cancelled",
  "open",
  "rto_rate",
  "cancel_rate",
  "delivered_revenue",
  "delivered_revenue_ex_gst",
] as const;

function rowLine(dimension: string, row: CodInsightRow): string {
  return [
    dimension,
    row.key,
    row.orders,
    row.delivered,
    row.rto,
    row.cancelled,
    row.open,
    row.rto_rate == null ? "" : row.rto_rate,
    row.cancel_rate == null ? "" : row.cancel_rate,
    row.delivered_revenue,
    row.delivered_revenue_ex_gst,
  ]
    .map(csvEscape)
    .join(",");
}

/**
 * UTF-8 BOM-less LF CSV. File name helper: sandy-cod-insights-<from>-<to>.csv
 */
export function codInsightsCsv(insights: CodInsightsBundle, range: CodInsightsRange): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  const dims: { name: string; rows: CodInsightRow[] }[] = [
    { name: "city", rows: insights.by_city },
    { name: "province", rows: insights.by_province },
    { name: "payment", rows: insights.by_payment },
    { name: "courier", rows: insights.by_courier },
    { name: "zone", rows: insights.by_zone },
  ];
  for (const d of dims) {
    for (const r of d.rows) lines.push(rowLine(d.name, r));
  }
  lines.push(rowLine("totals", insights.totals));
  // Range metadata as comment-free trailing note row is avoided; filename carries range.
  void range;
  return lines.join("\n") + "\n";
}

export function codInsightsCsvFilename(range: CodInsightsRange): string {
  const from = range.from || range.preset || "all";
  const to = range.to || range.preset || "all";
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `sandy-cod-insights-${safe(from)}-${safe(to)}.csv`;
}

/** Shared SQL metric expressions (must match dashboard revenue = delivered only). */
export const COD_INSIGHT_METRIC_SQL = `
  COUNT(*) AS orders,
  COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
  COALESCE(SUM(CASE WHEN COALESCE(o.rto, 0) = 1 THEN 1 ELSE 0 END), 0) AS rto,
  COALESCE(SUM(CASE WHEN o.status = 'cancelled' AND COALESCE(o.rto, 0) = 0 THEN 1 ELSE 0 END), 0) AS cancelled,
  COALESCE(SUM(CASE WHEN o.status NOT IN ('delivered', 'cancelled') THEN 1 ELSE 0 END), 0) AS open_cnt,
  COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total ELSE 0 END), 0) AS delivered_revenue,
  COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total - COALESCE(o.vat_amount, 0) ELSE 0 END), 0) AS delivered_revenue_ex_gst
`.replace(/\s+/g, " ").trim();
