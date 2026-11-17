/**
 * TAX-CONFIG-01 — pure tax engine.
 *
 * No DB, network, env or side effects. Rates / rules are always supplied by the caller
 * (server-loaded from the CMS tables). There are intentionally NO built-in default rates:
 * if a rate or rule cannot be resolved, the engine returns { ok: false } (fail safe).
 *
 * Money convention: inputs/outputs are PKR numbers. Internally all arithmetic is done in
 * integer paisa so rounding is deterministic. Tax per line is rounded to whole rupees
 * (half-up), then summed.
 *
 * NOTE: this file must stay import-free so it can run under `node --test` directly.
 */

export type TaxAppliesTo = "domestic" | "international" | "both";
export type TaxDestination = "domestic" | "international";
export type TaxBase = "after_discount" | "before_discount";
export type TaxRounding = "per_line_whole_rupee";

export type TaxClass = {
  id: number;
  name: string;
  slug: string;
  applies_to: TaxAppliesTo;
  active: boolean;
  sort_order: number;
};

/** One dated rate row. Rows are append-only: a change is a NEW row with a later effective_from. */
export type TaxRate = {
  id?: number;
  tax_class_id: number;
  rate_percent: number;
  /** ISO string or Date; compared as an instant. */
  effective_from: string | Date;
};

/** One dated rules row (global). Append-only like rates. */
export type TaxRules = {
  id?: number;
  tax_base: TaxBase;
  shipping_taxable: boolean;
  rounding: TaxRounding;
  tax_label: string;
  prices_include_tax: boolean;
  effective_from: string | Date;
};

/** Config effective at a single instant (what loadEffectiveTaxConfig returns). */
export type TaxConfig = {
  as_of: string;
  classes: TaxClass[];
  /** Effective rate per class id at as_of. Classes with no effective rate are absent. */
  rates: Record<number, TaxRate>;
  rules: TaxRules;
  /** Class used when a product has no tax_class_id (Physical goods). */
  default_class_id: number;
};

export type TaxLineInput = {
  /** Caller key (usually product id) echoed back in the result. */
  key: number | string;
  /** Line amount BEFORE discount, in PKR (price * qty). */
  amount: number;
  /** null/undefined => config.default_class_id */
  tax_class_id?: number | null;
};

export type TaxLineResult = {
  key: number | string;
  tax_class_id: number;
  tax_class_name: string;
  tax_class_slug: string;
  line_amount: number;
  discount_share: number;
  taxable_amount: number;
  rate_percent: number;
  /** false when the class does not apply to this destination (tax = 0). */
  applies: boolean;
  tax_amount: number;
};

export type TaxClassTotal = {
  tax_class_id: number;
  tax_class_name: string;
  rate_percent: number;
  taxable_amount: number;
  tax_amount: number;
};

export type TaxSnapshot = {
  version: 1;
  as_of: string;
  destination: TaxDestination;
  tax_label: string;
  tax_base: TaxBase;
  shipping_taxable: boolean;
  rounding: TaxRounding;
  prices_include_tax: boolean;
  rules_id: number | null;
  rate_ids: Record<string, number | null>;
  discount_amount: number;
  shipping_amount: number;
  shipping_tax: number;
  vat_amount: number;
  lines: TaxLineResult[];
  by_class: TaxClassTotal[];
};

export type CartTaxOk = {
  ok: true;
  lines: TaxLineResult[];
  shipping_tax: number;
  vat_amount: number;
  tax_label: string;
  by_class: TaxClassTotal[];
  snapshot: TaxSnapshot;
};

export type CartTaxResult = CartTaxOk | { ok: false; error: string };

export type ComputeCartTaxInput = {
  config: TaxConfig;
  lines: TaxLineInput[];
  /** Total coupon discount in PKR (allocated across lines). */
  discount_amount: number;
  /** Shipping in PKR (taxed only if rules.shipping_taxable). */
  shipping_amount?: number;
  destination?: TaxDestination;
};

// ───────────────────────── money helpers ─────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function toPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

function fromPaisa(paisa: number): number {
  return paisa / 100;
}

/** Integer round-half-up of num/den for non-negative integers. */
function divRoundHalfUp(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den));
}

/**
 * Round a rupee amount to whole rupees, half-up. Cleans float noise (…499999) first.
 * Negative inputs are mirrored (never expected for tax, but defined).
 */
export function roundPerLineWholeRupees(value: number): number {
  if (!isFiniteNumber(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const cleaned = Math.round(abs * 1e9) / 1e9;
  return sign * Math.floor(cleaned + 0.5);
}

/** rate_percent (e.g. 17 or 17.5) -> integer in 1/10000 of a percent. */
function rateScaled(ratePercent: number): number {
  return Math.round(ratePercent * 10000);
}

/**
 * Tax for ONE line, whole rupees (half-up).
 * exclusive: tax = taxable * rate
 * inclusive: tax = taxable * rate / (100 + rate)   (tax extracted from a tax-inclusive amount)
 */
export function computeLineTax(
  taxableAmount: number,
  ratePercent: number,
  opts?: { pricesIncludeTax?: boolean }
): number {
  if (!isFiniteNumber(taxableAmount) || taxableAmount <= 0) return 0;
  if (!isFiniteNumber(ratePercent) || ratePercent <= 0) return 0;
  const paisa = toPaisa(taxableAmount);
  const rs = rateScaled(ratePercent);
  if (opts?.pricesIncludeTax) {
    // rate fraction = rs / 1e6 ; tax = amount * f / (1 + f) = amount * rs / (1e6 + rs)
    const den = (1_000_000 + rs) * 100; // *100 converts paisa -> rupees
    return divRoundHalfUp(paisa * rs, den);
  }
  return divRoundHalfUp(paisa * rs, 100_000_000);
}

/**
 * Allocate a discount across lines proportionally to their amounts, in whole paisa,
 * using largest-remainder so shares sum EXACTLY to the allocated discount.
 * Discount is capped at the sum of the lines. Returns shares in PKR, same order as input.
 */
export function allocateDiscountToLines(
  lineAmounts: number[],
  discountAmount: number
): number[] {
  const n = lineAmounts.length;
  if (n === 0) return [];
  const paisaLines = lineAmounts.map((a) =>
    isFiniteNumber(a) && a > 0 ? toPaisa(a) : 0
  );
  const totalPaisa = paisaLines.reduce((s, v) => s + v, 0);
  const discPaisaRaw = isFiniteNumber(discountAmount) && discountAmount > 0 ? toPaisa(discountAmount) : 0;
  const discPaisa = Math.min(discPaisaRaw, totalPaisa);
  if (discPaisa <= 0 || totalPaisa <= 0) return lineAmounts.map(() => 0);

  const disc = BigInt(discPaisa);
  const total = BigInt(totalPaisa);
  const shares: number[] = [];
  const remainders: { index: number; rem: bigint }[] = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const product = disc * BigInt(paisaLines[i]);
    const floorShare = Number(product / total);
    const rem = product % total;
    shares.push(floorShare);
    allocated += floorShare;
    remainders.push({ index: i, rem });
  }
  let leftover = discPaisa - allocated;
  remainders.sort((a, b) => {
    if (a.rem === b.rem) return a.index - b.index;
    return a.rem > b.rem ? -1 : 1;
  });
  for (let k = 0; leftover > 0 && k < remainders.length; k++) {
    const idx = remainders[k].index;
    // never give a line more than its own amount
    if (shares[idx] < paisaLines[idx]) {
      shares[idx] += 1;
      leftover -= 1;
    }
  }
  return shares.map(fromPaisa);
}

// ───────────────────────── effective-date resolution ─────────────────────────

function toMs(v: string | Date): number {
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return ms;
}

/**
 * Latest rate row for a class whose effective_from <= asOf (ties: higher id wins).
 * Returns null if none — callers must treat that as an error, not as 0%.
 */
export function resolveEffectiveRate(
  rates: TaxRate[],
  taxClassId: number,
  asOf: Date
): TaxRate | null {
  const asOfMs = asOf.getTime();
  let best: TaxRate | null = null;
  let bestMs = -Infinity;
  for (const r of rates) {
    if (r.tax_class_id !== taxClassId) continue;
    const ms = toMs(r.effective_from);
    if (!Number.isFinite(ms) || ms > asOfMs) continue;
    if (
      !best ||
      ms > bestMs ||
      (ms === bestMs && (r.id ?? 0) > (best.id ?? 0))
    ) {
      best = r;
      bestMs = ms;
    }
  }
  return best;
}

/** Latest global rules row with effective_from <= asOf. null if none. */
export function resolveEffectiveRules(rules: TaxRules[], asOf: Date): TaxRules | null {
  const asOfMs = asOf.getTime();
  let best: TaxRules | null = null;
  let bestMs = -Infinity;
  for (const r of rules) {
    const ms = toMs(r.effective_from);
    if (!Number.isFinite(ms) || ms > asOfMs) continue;
    if (
      !best ||
      ms > bestMs ||
      (ms === bestMs && (r.id ?? 0) > (best.id ?? 0))
    ) {
      best = r;
      bestMs = ms;
    }
  }
  return best;
}

export function classAppliesToDestination(
  appliesTo: TaxAppliesTo,
  destination: TaxDestination
): boolean {
  return appliesTo === "both" || appliesTo === destination;
}

// ───────────────────────── cart computation ─────────────────────────

function aggregateByClass(lines: TaxLineResult[]): TaxClassTotal[] {
  const map = new Map<number, TaxClassTotal>();
  for (const l of lines) {
    const cur = map.get(l.tax_class_id);
    if (cur) {
      cur.taxable_amount = fromPaisa(toPaisa(cur.taxable_amount) + toPaisa(l.taxable_amount));
      cur.tax_amount += l.tax_amount;
    } else {
      map.set(l.tax_class_id, {
        tax_class_id: l.tax_class_id,
        tax_class_name: l.tax_class_name,
        rate_percent: l.applies ? l.rate_percent : 0,
        taxable_amount: l.taxable_amount,
        tax_amount: l.tax_amount,
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Compute tax for a whole cart.
 *
 * - tax_base after_discount (default): taxable = line - its share of the discount.
 * - tax_base before_discount: taxable = line (discount ignored for tax).
 * - Each line is rounded to whole rupees independently, then summed.
 * - A class whose applies_to excludes the destination gets 0 tax (and is marked applies=false).
 * - A missing class or missing effective rate => { ok:false } (never silently 0 / never a default rate).
 */
export function computeCartTax(input: ComputeCartTaxInput): CartTaxResult {
  const { config, lines } = input;
  const destination: TaxDestination = input.destination ?? "domestic";

  if (!config || !config.rules) return { ok: false, error: "Tax rules unavailable" };
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, error: "No lines to tax" };
  }
  if (!isFiniteNumber(input.discount_amount) || input.discount_amount < 0) {
    return { ok: false, error: "Invalid discount" };
  }
  const shippingAmount = input.shipping_amount ?? 0;
  if (!isFiniteNumber(shippingAmount) || shippingAmount < 0) {
    return { ok: false, error: "Invalid shipping" };
  }
  for (const l of lines) {
    if (!isFiniteNumber(l.amount) || l.amount < 0) {
      return { ok: false, error: "Invalid line amount" };
    }
  }

  const rules = config.rules;
  const classById = new Map<number, TaxClass>();
  for (const c of config.classes) classById.set(c.id, c);

  const shares = allocateDiscountToLines(
    lines.map((l) => l.amount),
    input.discount_amount
  );

  const results: TaxLineResult[] = [];
  const rateIds: Record<string, number | null> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classId = line.tax_class_id ?? config.default_class_id;
    const cls = classById.get(classId);
    if (!cls) return { ok: false, error: "Tax class unavailable" };
    const rate = config.rates[classId];
    if (!rate || !isFiniteNumber(rate.rate_percent) || rate.rate_percent < 0) {
      return { ok: false, error: "Tax rate unavailable" };
    }
    rateIds[String(classId)] = rate.id ?? null;

    const share = shares[i];
    const lineAmountPaisa = toPaisa(line.amount);
    const afterDiscount = fromPaisa(lineAmountPaisa - toPaisa(share));
    const taxable = rules.tax_base === "before_discount" ? fromPaisa(lineAmountPaisa) : afterDiscount;
    const applies = classAppliesToDestination(cls.applies_to, destination);
    const taxAmount = applies
      ? computeLineTax(taxable, rate.rate_percent, { pricesIncludeTax: rules.prices_include_tax })
      : 0;

    results.push({
      key: line.key,
      tax_class_id: classId,
      tax_class_name: cls.name,
      tax_class_slug: cls.slug,
      line_amount: fromPaisa(lineAmountPaisa),
      discount_share: share,
      taxable_amount: taxable,
      rate_percent: rate.rate_percent,
      applies,
      tax_amount: taxAmount,
    });
  }

  // Shipping: only taxed when the rules say so; uses the default class rate.
  let shippingTax = 0;
  if (rules.shipping_taxable && shippingAmount > 0) {
    const defCls = classById.get(config.default_class_id);
    const defRate = config.rates[config.default_class_id];
    if (!defCls || !defRate) return { ok: false, error: "Tax rate unavailable" };
    if (classAppliesToDestination(defCls.applies_to, destination)) {
      // Discount that exceeds the goods total spills onto shipping.
      const goodsTotalPaisa = lines.reduce((s, l) => s + toPaisa(l.amount), 0);
      const spill = Math.max(0, toPaisa(input.discount_amount) - goodsTotalPaisa);
      const shipTaxable =
        rules.tax_base === "before_discount"
          ? shippingAmount
          : fromPaisa(Math.max(0, toPaisa(shippingAmount) - spill));
      shippingTax = computeLineTax(shipTaxable, defRate.rate_percent, {
        pricesIncludeTax: rules.prices_include_tax,
      });
    }
  }

  const vat = results.reduce((s, l) => s + l.tax_amount, 0) + shippingTax;
  const byClass = aggregateByClass(results);

  const snapshot: TaxSnapshot = {
    version: 1,
    as_of: config.as_of,
    destination,
    tax_label: rules.tax_label,
    tax_base: rules.tax_base,
    shipping_taxable: rules.shipping_taxable,
    rounding: rules.rounding,
    prices_include_tax: rules.prices_include_tax,
    rules_id: rules.id ?? null,
    rate_ids: rateIds,
    discount_amount: fromPaisa(toPaisa(input.discount_amount)),
    shipping_amount: fromPaisa(toPaisa(shippingAmount)),
    shipping_tax: shippingTax,
    vat_amount: vat,
    lines: results,
    by_class: byClass,
  };

  return {
    ok: true,
    lines: results,
    shipping_tax: shippingTax,
    vat_amount: vat,
    tax_label: rules.tax_label,
    by_class: byClass,
    snapshot,
  };
}
