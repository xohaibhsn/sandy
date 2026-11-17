/**
 * Shared admin order list/filter/export helpers (no request-time DDL).
 */
import { parseIsoDate, resolvePktRange } from "./pktDateRange";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "dispatched",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Payment methods as stored / accepted by checkout. */
export const PAYMENT_METHODS = ["cod", "jazzcash", "easypaisa", "bank"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const EXPORT_MAX = 10_000;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function escapeLikeWildcards(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * CSV cell escape with spreadsheet formula-injection defense.
 * Any cell whose first character is = + - @ TAB or CR is prefixed with an apostrophe.
 */
export function csvEscapeCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  const first = s.length > 0 ? s[0] : "";
  if (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r"
  ) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type OrderFilters = {
  q: string;
  status: OrderStatus | null;
  paymentMethod: PaymentMethod | null;
  /** Inclusive PKT day start as UTC SQL (created_at lower bound). */
  fromSql: string | null;
  /** Exclusive PKT day end as UTC SQL. */
  toExclusiveSql: string | null;
  preset: string;
  from: string | null;
  to: string | null;
};

export type ParseFiltersResult =
  | { ok: true; filters: OrderFilters; page: number; pageSize: number }
  | { ok: false; error: string };

function emptyFilters(): OrderFilters {
  return {
    q: "",
    status: null,
    paymentMethod: null,
    fromSql: null,
    toExclusiveSql: null,
    preset: "all",
    from: null,
    to: null,
  };
}

export function parseOrderListQuery(
  query: Record<string, string | string[] | undefined> | Record<string, unknown>
): ParseFiltersResult {
  const page = clampInt(query.page, 1, 1_000_000, 1);
  const rawSize = clampInt(query.pageSize ?? query.limit, 1, 100, 25);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : -1;
  if (pageSize < 0) {
    return { ok: false, error: "Invalid request" };
  }

  let q = String(query.q ?? "").trim();
  if (q) {
    if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) {
      return { ok: false, error: "Invalid request" };
    }
  } else {
    q = "";
  }

  const statusRaw = String(query.status ?? "all").trim().toLowerCase();
  let status: OrderStatus | null = null;
  if (statusRaw && statusRaw !== "all") {
    if (!(ORDER_STATUSES as readonly string[]).includes(statusRaw)) {
      return { ok: false, error: "Invalid request" };
    }
    status = statusRaw as OrderStatus;
  }

  const paymentRaw = String(query.payment_method ?? query.paymentMethod ?? "")
    .trim()
    .toLowerCase();
  let paymentMethod: PaymentMethod | null = null;
  if (paymentRaw && paymentRaw !== "all") {
    if (!(PAYMENT_METHODS as readonly string[]).includes(paymentRaw)) {
      return { ok: false, error: "Invalid request" };
    }
    paymentMethod = paymentRaw as PaymentMethod;
  }

  const hasPreset = query.preset != null && String(query.preset).trim() !== "";
  const hasFrom = query.from != null && String(query.from).trim() !== "";
  const hasTo = query.to != null && String(query.to).trim() !== "";

  let rangeInput: { preset?: unknown; from?: unknown; to?: unknown };
  if (hasPreset) {
    rangeInput = { preset: query.preset, from: query.from, to: query.to };
  } else if (hasFrom || hasTo) {
    if (!hasFrom || !hasTo) {
      return { ok: false, error: "Invalid request" };
    }
    if (!parseIsoDate(String(query.from).trim()) || !parseIsoDate(String(query.to).trim())) {
      return { ok: false, error: "Invalid request" };
    }
    rangeInput = { preset: "custom", from: query.from, to: query.to };
  } else {
    rangeInput = { preset: "all" };
  }

  const range = resolvePktRange(rangeInput);
  if (!range.ok) {
    return { ok: false, error: "Invalid request" };
  }

  return {
    ok: true,
    page,
    pageSize,
    filters: {
      q,
      status,
      paymentMethod,
      fromSql: range.fromSql,
      toExclusiveSql: range.toExclusiveSql,
      preset: range.preset,
      from: range.from,
      to: range.to,
    },
  };
}

export function buildOrderWhere(
  filters: OrderFilters,
  alias = "o"
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const col = (name: string) => (alias ? `${alias}.${name}` : name);

  if (filters.q) {
    const like = `%${escapeLikeWildcards(filters.q)}%`;
    // ESCAPE '\\' → one backslash in SQL (JS string needs four backslashes).
    where.push(
      `(${col("order_id")} LIKE ? ESCAPE '\\\\' OR ${col(
        "customer_name"
      )} LIKE ? ESCAPE '\\\\' OR ${col("customer_email")} LIKE ? ESCAPE '\\\\' OR ${col(
        "customer_phone"
      )} LIKE ? ESCAPE '\\\\')`
    );
    params.push(like, like, like, like);
  }
  if (filters.status) {
    where.push(`${col("status")} = ?`);
    params.push(filters.status);
  }
  if (filters.paymentMethod) {
    where.push(`${col("payment_method")} = ?`);
    params.push(filters.paymentMethod);
  }
  if (filters.fromSql) {
    where.push(`${col("created_at")} >= ?`);
    params.push(filters.fromSql);
  }
  if (filters.toExclusiveSql) {
    where.push(`${col("created_at")} < ?`);
    params.push(filters.toExclusiveSql);
  }

  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export async function itemsMetaForOrderIds(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orderIds: string[]
): Promise<Record<string, { items_list: string; items_count: number }>> {
  const map: Record<string, { items_list: string; items_count: number }> = {};
  if (!orderIds.length) return map;
  const placeholders = orderIds.map(() => "?").join(",");
  const [rows] = (await pool.query(
    `SELECT order_id,
            GROUP_CONCAT(CONCAT(product_name, ' x ', quantity) ORDER BY id SEPARATOR '; ') AS items_list,
            COUNT(*) AS items_count
     FROM order_items
     WHERE order_id IN (${placeholders})
     GROUP BY order_id`,
    orderIds
  )) as [Array<Record<string, unknown>>, unknown];
  for (const r of Array.isArray(rows) ? rows : []) {
    map[String(r.order_id)] = {
      items_list: String(r.items_list || ""),
      items_count: Number(r.items_count || 0),
    };
  }
  return map;
}

export async function taxLabelsForOrderIds(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orderIds: string[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!orderIds.length) return map;
  try {
    const placeholders = orderIds.map(() => "?").join(",");
    const [rows] = (await pool.query(
      `SELECT order_id, tax_label FROM order_tax_snapshots WHERE order_id IN (${placeholders})`,
      orderIds
    )) as [Array<Record<string, unknown>>, unknown];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (typeof r.tax_label === "string" && r.tax_label.trim()) {
        map[String(r.order_id)] = r.tax_label.trim();
      }
    }
  } catch {
    /* snapshot table missing — callers fall back to "Tax" */
  }
  return map;
}

export { emptyFilters };
