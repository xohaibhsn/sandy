/**
 * TAX-CONFIG-01 — DB access for tax configuration.
 *
 * Read-only. No runtime DDL. NO fallback rates: if the tax tables are missing, empty,
 * or unreadable, loadEffectiveTaxConfig throws TaxConfigUnavailableError and checkout
 * must fail safe (HTTP 503 { error: "Tax configuration unavailable" }).
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  resolveEffectiveRate,
  resolveEffectiveRules,
  type TaxAppliesTo,
  type TaxBase,
  type TaxClass,
  type TaxConfig,
  type TaxRate,
  type TaxRules,
} from "./taxEngine";

export const TAX_CONFIG_UNAVAILABLE_MESSAGE = "Tax configuration unavailable";
export const DEFAULT_TAX_CLASS_SLUG = "physical-goods";

export type TaxConfigUnavailableReason =
  | "tables_missing"
  | "columns_missing"
  | "db_error"
  | "incomplete_config";

export class TaxConfigUnavailableError extends Error {
  reason: TaxConfigUnavailableReason;
  constructor(reason: TaxConfigUnavailableReason, detail?: string) {
    // Public message stays generic; detail is for server logs only.
    super(TAX_CONFIG_UNAVAILABLE_MESSAGE);
    this.name = "TaxConfigUnavailableError";
    this.reason = reason;
    if (detail) this.detail = detail;
  }
  detail?: string;
}

export type TaxQueryable = Pick<Pool | PoolConnection, "query">;

type Mysqlish = { errno?: number; code?: string; message?: string };

/** ER_NO_SUCH_TABLE (1146) / ER_BAD_FIELD_ERROR (1054) detection. */
export function classifyTaxDbError(err: unknown): TaxConfigUnavailableReason {
  const e = (err && typeof err === "object" ? err : {}) as Mysqlish;
  if (e.errno === 1146 || e.code === "ER_NO_SUCH_TABLE") return "tables_missing";
  if (e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR") return "columns_missing";
  return "db_error";
}

export function isTaxConfigUnavailableError(err: unknown): err is TaxConfigUnavailableError {
  return err instanceof TaxConfigUnavailableError;
}

/** Wrap a failed tax-related query into the fail-safe error (logs detail server-side). */
export function toTaxUnavailable(err: unknown, context: string): TaxConfigUnavailableError {
  if (err instanceof TaxConfigUnavailableError) return err;
  const reason = classifyTaxDbError(err);
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[tax] ${context} failed (${reason}):`, msg);
  return new TaxConfigUnavailableError(reason, msg);
}

function asAppliesTo(v: unknown): TaxAppliesTo | null {
  return v === "domestic" || v === "international" || v === "both" ? v : null;
}

function asTaxBase(v: unknown): TaxBase | null {
  return v === "after_discount" || v === "before_discount" ? v : null;
}

function toIso(v: unknown): string | null {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export type ClassRow = RowDataPacket & {
  id: number;
  name: string;
  slug: string;
  applies_to: unknown;
  active: unknown;
  sort_order: unknown;
};

export type RateRow = RowDataPacket & {
  id: number;
  tax_class_id: number;
  rate_percent: unknown;
  effective_from: unknown;
};

export type RuleRow = RowDataPacket & {
  id: number;
  tax_base: unknown;
  shipping_taxable: unknown;
  rounding: unknown;
  tax_label: unknown;
  prices_include_tax: unknown;
  effective_from: unknown;
};

export function mapClassRow(row: ClassRow): TaxClass | null {
  const applies = asAppliesTo(row.applies_to);
  const id = Number(row.id);
  if (!applies || !Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    applies_to: applies,
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order) || 0,
  };
}

export function mapRateRow(row: RateRow): TaxRate | null {
  const rate = Number(row.rate_percent);
  const from = toIso(row.effective_from);
  const id = Number(row.id);
  const classId = Number(row.tax_class_id);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !from) return null;
  if (!Number.isInteger(classId) || classId <= 0) return null;
  return { id, tax_class_id: classId, rate_percent: rate, effective_from: from };
}

export function mapRuleRow(row: RuleRow): TaxRules | null {
  const base = asTaxBase(row.tax_base);
  const from = toIso(row.effective_from);
  const label = typeof row.tax_label === "string" ? row.tax_label.trim() : "";
  if (!base || !from || !label) return null;
  return {
    id: Number(row.id),
    tax_base: base,
    shipping_taxable: Number(row.shipping_taxable) === 1,
    rounding: "per_line_whole_rupee",
    tax_label: label,
    prices_include_tax: Number(row.prices_include_tax) === 1,
    effective_from: from,
  };
}

/**
 * Load the tax configuration effective at `asOfDate`.
 * Throws TaxConfigUnavailableError if tables are missing/empty/unreadable or the
 * default (Physical goods) class has no effective rate.
 */
export async function loadEffectiveTaxConfig(
  connection: TaxQueryable,
  asOfDate: Date = new Date()
): Promise<TaxConfig> {
  let classRows: ClassRow[];
  let rateRows: RateRow[];
  let ruleRows: RuleRow[];
  try {
    [classRows] = await connection.query<ClassRow[]>(
      `SELECT id, name, slug, applies_to, active, sort_order
       FROM tax_classes
       ORDER BY sort_order ASC, id ASC`
    );
    [rateRows] = await connection.query<RateRow[]>(
      `SELECT id, tax_class_id, rate_percent, effective_from
       FROM tax_rates
       WHERE effective_from <= ?
       ORDER BY effective_from DESC, id DESC`,
      [asOfDate]
    );
    [ruleRows] = await connection.query<RuleRow[]>(
      `SELECT id, tax_base, shipping_taxable, rounding, tax_label, prices_include_tax, effective_from
       FROM tax_rules
       WHERE effective_from <= ?
       ORDER BY effective_from DESC, id DESC`,
      [asOfDate]
    );
  } catch (err) {
    throw toTaxUnavailable(err, "loadEffectiveTaxConfig");
  }

  const classes = (Array.isArray(classRows) ? classRows : [])
    .map(mapClassRow)
    .filter((c): c is TaxClass => c !== null);
  const rates = (Array.isArray(rateRows) ? rateRows : [])
    .map(mapRateRow)
    .filter((r): r is TaxRate => r !== null);
  const rulesList = (Array.isArray(ruleRows) ? ruleRows : [])
    .map(mapRuleRow)
    .filter((r): r is TaxRules => r !== null);

  if (classes.length === 0) {
    throw new TaxConfigUnavailableError("incomplete_config", "no tax classes");
  }

  const rules = resolveEffectiveRules(rulesList, asOfDate);
  if (!rules) {
    throw new TaxConfigUnavailableError("incomplete_config", "no effective tax rules");
  }

  const defaultClass = classes.find((c) => c.slug === DEFAULT_TAX_CLASS_SLUG);
  if (!defaultClass) {
    throw new TaxConfigUnavailableError("incomplete_config", "default tax class missing");
  }

  const effectiveRates: Record<number, TaxRate> = {};
  for (const c of classes) {
    const r = resolveEffectiveRate(rates, c.id, asOfDate);
    if (r) effectiveRates[c.id] = r;
  }
  if (!effectiveRates[defaultClass.id]) {
    throw new TaxConfigUnavailableError("incomplete_config", "default class has no effective rate");
  }

  return {
    as_of: asOfDate.toISOString(),
    classes,
    rates: effectiveRates,
    rules,
    default_class_id: defaultClass.id,
  };
}
