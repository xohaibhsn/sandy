/**
 * Read-only schema probes for migration 0009 (SANDY-BATCH-12). The app never creates or alters tables.
 *
 * Cache semantics (same as hasCancelReasonColumn in lib/orderCancel.ts):
 *   - a POSITIVE result is cached for the process lifetime;
 *   - a NEGATIVE result (or a probe failure) is re-checked at most every 30 seconds, so the feature
 *     turns on automatically after the owner applies the migration (no redeploy).
 *
 * Probes use INFORMATION_SCHEMA with TABLE_SCHEMA = DATABASE() and take any pool / connection, so
 * they can run on a transaction connection and in unit tests with a mocked `query`.
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Queryable = Pick<Pool | PoolConnection, "query">;

export const NEGATIVE_RECHECK_MS = 30_000;

export const SHIPPING_ORDER_COLUMNS = [
  "shipping_amount",
  "shipping_zone",
  "courier_id",
  "tracking_number",
  "shipped_at",
  "delivered_at",
  "rto",
  "rto_at",
] as const;

export const SHIPPING_TABLES = ["shipping_zones", "couriers"] as const;

type ProbeState = { present: boolean | null; lastNegativeAt: number };

function newState(): ProbeState {
  return { present: null, lastNegativeAt: 0 };
}

const orderColumnsState = newState();
const requiresShippingState = newState();
const rtoState = newState();
const tablesState = newState();

function reset(state: ProbeState): void {
  state.present = null;
  state.lastNegativeAt = 0;
}

/** Test-only: forget every cached probe result. */
export function resetShippingSchemaCache(): void {
  reset(orderColumnsState);
  reset(requiresShippingState);
  reset(rtoState);
  reset(tablesState);
}

/** Test-only: forget the cached orders.rto probe (used by lib/codRisk.ts). */
export function resetRtoColumnCache(): void {
  reset(rtoState);
}

async function cachedProbe(
  state: ProbeState,
  run: () => Promise<boolean>
): Promise<boolean> {
  if (state.present === true) return true;

  const now = Date.now();
  if (state.present === false && now - state.lastNegativeAt < NEGATIVE_RECHECK_MS) {
    return false;
  }

  try {
    const found = await run();
    if (found) {
      state.present = true;
      return true;
    }
    state.present = false;
    state.lastNegativeAt = now;
    return false;
  } catch {
    state.present = false;
    state.lastNegativeAt = now;
    return false;
  }
}

async function columnsExist(
  db: Queryable,
  table: string,
  columns: readonly string[]
): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${columns.map(() => "?").join(",")})`,
    [table, ...columns]
  );
  if (!Array.isArray(rows)) return false;
  const found = new Set(rows.map((r) => String(r.COLUMN_NAME ?? r.column_name ?? "")));
  return columns.every((c) => found.has(c));
}

/** All eight orders.* shipping / courier / RTO columns exist. */
export function hasShippingOrderColumns(db: Queryable): Promise<boolean> {
  return cachedProbe(orderColumnsState, () => columnsExist(db, "orders", SHIPPING_ORDER_COLUMNS));
}

/** products.requires_shipping exists. */
export function hasRequiresShippingColumn(db: Queryable): Promise<boolean> {
  return cachedProbe(requiresShippingState, () =>
    columnsExist(db, "products", ["requires_shipping"])
  );
}

/** orders.rto exists (the only probe the COD-risk history needs). */
export function hasRtoColumn(db: Queryable): Promise<boolean> {
  return cachedProbe(rtoState, () => columnsExist(db, "orders", ["rto"]));
}

/** shipping_zones and couriers tables exist. */
export function hasShippingTables(db: Queryable): Promise<boolean> {
  return cachedProbe(tablesState, async () => {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${SHIPPING_TABLES.map(() => "?").join(",")})`,
      [...SHIPPING_TABLES]
    );
    if (!Array.isArray(rows)) return false;
    const found = new Set(rows.map((r) => String(r.TABLE_NAME ?? r.table_name ?? "")));
    return SHIPPING_TABLES.every((t) => found.has(t));
  });
}

/**
 * Everything checkout needs when shipping_enabled = 1: both tables, the eight orders columns and
 * products.requires_shipping. False => callers must answer 503 { error: "Service unavailable" }.
 */
export async function hasShippingSchema(db: Queryable): Promise<boolean> {
  if (!(await hasShippingTables(db))) return false;
  if (!(await hasShippingOrderColumns(db))) return false;
  return hasRequiresShippingColumn(db);
}
