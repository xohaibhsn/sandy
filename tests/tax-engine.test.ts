// Run with: npm test   (node --test, Node >= 22.18 / 24 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateDiscountToLines,
  computeCartTax,
  computeLineTax,
  resolveEffectiveRate,
  resolveEffectiveRules,
  roundPerLineWholeRupees,
  type TaxAppliesTo,
  type TaxBase,
  type TaxClass,
  type TaxConfig,
  type TaxRate,
  type TaxRules,
} from "../lib/taxEngine.ts";

// ── fixtures (test-only numbers; the engine itself has no built-in rates) ──
function makeClasses(overrides?: Partial<Record<number, TaxAppliesTo>>): TaxClass[] {
  return [
    { id: 1, name: "Physical goods", slug: "physical-goods", applies_to: overrides?.[1] ?? "both", active: true, sort_order: 10 },
    { id: 2, name: "Digital products", slug: "digital-products", applies_to: overrides?.[2] ?? "both", active: true, sort_order: 20 },
    { id: 3, name: "Services", slug: "services", applies_to: overrides?.[3] ?? "both", active: true, sort_order: 30 },
  ];
}

function makeRules(partial?: Partial<TaxRules>): TaxRules {
  return {
    id: 1,
    tax_base: "after_discount",
    shipping_taxable: false,
    rounding: "per_line_whole_rupee",
    tax_label: "GST",
    prices_include_tax: false,
    effective_from: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function makeConfig(opts?: {
  rates?: Record<number, number>;
  rules?: Partial<TaxRules>;
  applies?: Partial<Record<number, TaxAppliesTo>>;
  omitRateFor?: number;
}): TaxConfig {
  const rateMap = opts?.rates ?? { 1: 17, 2: 17, 3: 17 };
  const rates: Record<number, TaxRate> = {};
  for (const [id, pct] of Object.entries(rateMap)) {
    if (Number(id) === opts?.omitRateFor) continue;
    rates[Number(id)] = {
      id: Number(id),
      tax_class_id: Number(id),
      rate_percent: pct,
      effective_from: "2026-01-01T00:00:00.000Z",
    };
  }
  return {
    as_of: "2026-06-01T00:00:00.000Z",
    classes: makeClasses(opts?.applies),
    rates,
    rules: makeRules(opts?.rules),
    default_class_id: 1,
  };
}

function ok(res: ReturnType<typeof computeCartTax>) {
  assert.equal(res.ok, true, res.ok ? "" : (res as { error: string }).error);
  if (!res.ok) throw new Error("unreachable");
  return res;
}

// ── rounding ──
test("roundPerLineWholeRupees rounds half-up and ignores float noise", () => {
  assert.equal(roundPerLineWholeRupees(25.5), 26);
  assert.equal(roundPerLineWholeRupees(25.499999999999996), 26); // float noise of 25.5
  assert.equal(roundPerLineWholeRupees(25.4999999), 25);
  assert.equal(roundPerLineWholeRupees(0.49), 0);
  assert.equal(roundPerLineWholeRupees(0), 0);
});

test("computeLineTax: 17% whole-rupee half-up", () => {
  assert.equal(computeLineTax(100, 17), 17);
  assert.equal(computeLineTax(150, 17), 26); // 25.5 -> 26
  assert.equal(computeLineTax(2.9, 17), 0); // 0.493
  assert.equal(computeLineTax(3, 17), 1); // 0.51
  assert.equal(computeLineTax(99.99, 17), 17); // 16.998
  assert.equal(computeLineTax(2.5, 20), 1); // exactly 0.5 -> 1
});

test("computeLineTax: zero / invalid inputs give 0", () => {
  assert.equal(computeLineTax(1000, 0), 0);
  assert.equal(computeLineTax(0, 17), 0);
  assert.equal(computeLineTax(-5, 17), 0);
  assert.equal(computeLineTax(Number.NaN, 17), 0);
});

test("rounding is PER LINE then summed (not on the cart total)", () => {
  // 3 lines of Rs 3 at 17%: each 0.51 -> 1  => 3 ; aggregate Rs 9 * 17% = 1.53 -> 2
  const res = ok(
    computeCartTax({
      config: makeConfig(),
      lines: [
        { key: "a", amount: 3 },
        { key: "b", amount: 3 },
        { key: "c", amount: 3 },
      ],
      discount_amount: 0,
    })
  );
  assert.deepEqual(res.lines.map((l) => l.tax_amount), [1, 1, 1]);
  assert.equal(res.vat_amount, 3);
  assert.equal(computeLineTax(9, 17), 2);
});

test("tax amounts are always whole rupees", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rates: { 1: 17.5, 2: 17, 3: 17 } }),
      lines: [
        { key: 1, amount: 333.33 },
        { key: 2, amount: 49.99, tax_class_id: 2 },
      ],
      discount_amount: 12.34,
    })
  );
  for (const l of res.lines) assert.equal(Number.isInteger(l.tax_amount), true);
  assert.equal(Number.isInteger(res.vat_amount), true);
});

// ── discount allocation ──
test("allocateDiscountToLines sums exactly to the discount (largest remainder)", () => {
  const shares = allocateDiscountToLines([100, 200, 300], 100);
  const sumPaisa = shares.reduce((s, v) => s + Math.round(v * 100), 0);
  assert.equal(sumPaisa, 10000);
  assert.deepEqual(shares, [16.67, 33.33, 50]);
});

test("allocateDiscountToLines caps at the goods total and handles zero", () => {
  assert.deepEqual(allocateDiscountToLines([100, 100], 500), [100, 100]);
  assert.deepEqual(allocateDiscountToLines([100, 100], 0), [0, 0]);
  assert.deepEqual(allocateDiscountToLines([], 10), []);
  assert.deepEqual(allocateDiscountToLines([0, 0], 10), [0, 0]);
});

test("allocateDiscountToLines never over-allocates a line", () => {
  const shares = allocateDiscountToLines([0.01, 0.01, 0.01], 0.02);
  const sumPaisa = shares.reduce((s, v) => s + Math.round(v * 100), 0);
  assert.equal(sumPaisa, 2);
  for (const s of shares) assert.ok(s <= 0.01);
});

// ── tax base ──
test("after_discount (default): tax on line minus its share of the coupon", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig(),
      lines: [{ key: 1, amount: 1000 }],
      discount_amount: 100,
    })
  );
  assert.equal(res.lines[0].taxable_amount, 900);
  assert.equal(res.vat_amount, 153); // 17% of 900
  assert.equal(res.tax_label, "GST");
});

test("before_discount rule: tax on full line amount", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rules: { tax_base: "before_discount" as TaxBase } }),
      lines: [{ key: 1, amount: 1000 }],
      discount_amount: 100,
    })
  );
  assert.equal(res.lines[0].taxable_amount, 1000);
  assert.equal(res.vat_amount, 170);
});

test("discount is shared across lines proportionally before tax", () => {
  // 600 + 400, discount 100 => shares 60 / 40 => taxable 540 / 360
  const res = ok(
    computeCartTax({
      config: makeConfig(),
      lines: [
        { key: "p", amount: 600 },
        { key: "q", amount: 400 },
      ],
      discount_amount: 100,
    })
  );
  assert.deepEqual(res.lines.map((l) => l.discount_share), [60, 40]);
  assert.deepEqual(res.lines.map((l) => l.taxable_amount), [540, 360]);
  assert.deepEqual(res.lines.map((l) => l.tax_amount), [92, 61]); // 91.8 -> 92 ; 61.2 -> 61
  assert.equal(res.vat_amount, 153);
});

// ── multi-class ──
test("multi-class cart: each line uses its own class rate; unassigned => default class", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rates: { 1: 17, 2: 10, 3: 5 } }),
      lines: [
        { key: "phys", amount: 1000, tax_class_id: null }, // default => Physical goods 17%
        { key: "dig", amount: 1000, tax_class_id: 2 },
        { key: "svc", amount: 1000, tax_class_id: 3 },
      ],
      discount_amount: 0,
    })
  );
  assert.deepEqual(res.lines.map((l) => l.tax_class_slug), ["physical-goods", "digital-products", "services"]);
  assert.deepEqual(res.lines.map((l) => l.tax_amount), [170, 100, 50]);
  assert.equal(res.vat_amount, 320);
  assert.equal(res.by_class.length, 3);
});

test("two lines in the same class aggregate in by_class but are rounded individually", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig(),
      lines: [
        { key: 1, amount: 3, tax_class_id: 2 },
        { key: 2, amount: 3, tax_class_id: 2 },
      ],
      discount_amount: 0,
    })
  );
  assert.equal(res.by_class.length, 1);
  assert.equal(res.by_class[0].tax_amount, 2);
  assert.equal(res.by_class[0].taxable_amount, 6);
});

// ── edge: 100% coupon / zero rate ──
test("100% coupon => taxable 0 and vat 0 (after_discount)", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig(),
      lines: [
        { key: 1, amount: 999 },
        { key: 2, amount: 501, tax_class_id: 2 },
      ],
      discount_amount: 1500,
    })
  );
  assert.equal(res.vat_amount, 0);
  assert.deepEqual(res.lines.map((l) => l.taxable_amount), [0, 0]);
});

test("100% coupon with before_discount rule still taxes the full amount (explicit rule)", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rules: { tax_base: "before_discount" } }),
      lines: [{ key: 1, amount: 1000 }],
      discount_amount: 1000,
    })
  );
  assert.equal(res.vat_amount, 170);
});

test("zero-rate class yields 0 tax without error", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rates: { 1: 17, 2: 0, 3: 17 } }),
      lines: [{ key: 1, amount: 5000, tax_class_id: 2 }],
      discount_amount: 0,
    })
  );
  assert.equal(res.vat_amount, 0);
  assert.equal(res.lines[0].applies, true);
});

// ── domestic vs international ──
test("both: same Pakistani rate for domestic and international by default", () => {
  const cfg = makeConfig();
  const lines = [{ key: 1, amount: 1000 }];
  const dom = ok(computeCartTax({ config: cfg, lines, discount_amount: 0, destination: "domestic" }));
  const intl = ok(computeCartTax({ config: cfg, lines, discount_amount: 0, destination: "international" }));
  assert.equal(dom.vat_amount, 170);
  assert.equal(intl.vat_amount, 170);
});

test("applies_to=domestic: international destination pays 0 tax on that class", () => {
  const cfg = makeConfig({ applies: { 1: "domestic" } });
  const lines = [
    { key: "goods", amount: 1000 }, // class 1 (domestic only)
    { key: "digital", amount: 1000, tax_class_id: 2 }, // both
  ];
  const intl = ok(computeCartTax({ config: cfg, lines, discount_amount: 0, destination: "international" }));
  assert.equal(intl.lines[0].applies, false);
  assert.equal(intl.lines[0].tax_amount, 0);
  assert.equal(intl.lines[1].tax_amount, 170);
  assert.equal(intl.vat_amount, 170);
  const dom = ok(computeCartTax({ config: cfg, lines, discount_amount: 0, destination: "domestic" }));
  assert.equal(dom.vat_amount, 340);
});

test("applies_to=international: domestic destination pays 0 on that class", () => {
  const cfg = makeConfig({ applies: { 3: "international" } });
  const dom = ok(
    computeCartTax({ config: cfg, lines: [{ key: 1, amount: 1000, tax_class_id: 3 }], discount_amount: 0, destination: "domestic" })
  );
  assert.equal(dom.vat_amount, 0);
  const intl = ok(
    computeCartTax({ config: cfg, lines: [{ key: 1, amount: 1000, tax_class_id: 3 }], discount_amount: 0, destination: "international" })
  );
  assert.equal(intl.vat_amount, 170);
});

// ── effective_from: only NEW orders see new rows ──
test("resolveEffectiveRate picks the latest row at or before the order time", () => {
  const rates: TaxRate[] = [
    { id: 1, tax_class_id: 1, rate_percent: 17, effective_from: "2026-01-01T00:00:00.000Z" },
    { id: 2, tax_class_id: 1, rate_percent: 18, effective_from: "2026-12-01T00:00:00.000Z" },
    { id: 3, tax_class_id: 2, rate_percent: 10, effective_from: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(resolveEffectiveRate(rates, 1, new Date("2026-11-17T00:00:00Z"))?.rate_percent, 17);
  assert.equal(resolveEffectiveRate(rates, 1, new Date("2026-12-01T00:00:00Z"))?.rate_percent, 18);
  assert.equal(resolveEffectiveRate(rates, 1, new Date("2027-03-01T00:00:00Z"))?.rate_percent, 18);
  assert.equal(resolveEffectiveRate(rates, 2, new Date("2027-03-01T00:00:00Z"))?.rate_percent, 10);
  // before the first row, and unknown class: null (never a default rate)
  assert.equal(resolveEffectiveRate(rates, 1, new Date("2025-12-31T00:00:00Z")), null);
  assert.equal(resolveEffectiveRate(rates, 99, new Date("2027-01-01T00:00:00Z")), null);
});

test("same effective_from: higher id wins", () => {
  const rates: TaxRate[] = [
    { id: 5, tax_class_id: 1, rate_percent: 15, effective_from: "2026-01-01T00:00:00.000Z" },
    { id: 6, tax_class_id: 1, rate_percent: 16, effective_from: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(resolveEffectiveRate(rates, 1, new Date("2026-02-01T00:00:00Z"))?.id, 6);
});

test("resolveEffectiveRules picks the latest rules row at or before the order time", () => {
  const rules: TaxRules[] = [
    makeRules({ id: 1, tax_label: "GST", effective_from: "2026-01-01T00:00:00.000Z" }),
    makeRules({ id: 2, tax_label: "Sales Tax", tax_base: "before_discount", effective_from: "2026-12-01T00:00:00.000Z" }),
  ];
  assert.equal(resolveEffectiveRules(rules, new Date("2026-11-17T00:00:00Z"))?.tax_label, "GST");
  assert.equal(resolveEffectiveRules(rules, new Date("2026-12-02T00:00:00Z"))?.tax_label, "Sales Tax");
  assert.equal(resolveEffectiveRules(rules, new Date("2025-01-01T00:00:00Z")), null);
});

test("a later rate row changes NEW orders only; an already-computed order keeps its amounts", () => {
  const rateRows: TaxRate[] = [
    { id: 1, tax_class_id: 1, rate_percent: 17, effective_from: "2026-01-01T00:00:00.000Z" },
  ];
  const buildConfig = (asOf: Date): TaxConfig => {
    const r = resolveEffectiveRate(rateRows, 1, asOf);
    return {
      as_of: asOf.toISOString(),
      classes: makeClasses(),
      rates: r ? { 1: r } : {},
      rules: makeRules(),
      default_class_id: 1,
    };
  };

  const placedAt = new Date("2026-11-17T10:00:00Z");
  const oldOrder = ok(computeCartTax({ config: buildConfig(placedAt), lines: [{ key: 1, amount: 1000 }], discount_amount: 0 }));
  assert.equal(oldOrder.vat_amount, 170);
  const storedSnapshot = JSON.stringify(oldOrder.snapshot); // what order_tax_snapshots would hold

  // owner adds a NEW dated row (never edits the old one)
  rateRows.push({ id: 2, tax_class_id: 1, rate_percent: 18, effective_from: "2026-11-18T00:00:00.000Z" });

  // order placed before the effective date still computes 17% (and the stored snapshot is untouched)
  const stillOld = ok(computeCartTax({ config: buildConfig(placedAt), lines: [{ key: 1, amount: 1000 }], discount_amount: 0 }));
  assert.equal(stillOld.vat_amount, 170);
  assert.equal(JSON.stringify(oldOrder.snapshot), storedSnapshot);
  assert.equal(JSON.parse(storedSnapshot).vat_amount, 170);

  // a new order after the effective date picks up 18%
  const newOrder = ok(
    computeCartTax({ config: buildConfig(new Date("2026-11-18T00:00:01Z")), lines: [{ key: 1, amount: 1000 }], discount_amount: 0 })
  );
  assert.equal(newOrder.vat_amount, 180);
  assert.deepEqual(newOrder.snapshot.rate_ids, { "1": 2 });
});

// ── fail safe: no hidden defaults ──
test("missing effective rate for a used class fails (no fallback rate)", () => {
  const res = computeCartTax({
    config: makeConfig({ omitRateFor: 2 }),
    lines: [{ key: 1, amount: 1000, tax_class_id: 2 }],
    discount_amount: 0,
  });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /^Tax /);
});

test("unknown tax class fails closed", () => {
  const res = computeCartTax({
    config: makeConfig(),
    lines: [{ key: 1, amount: 1000, tax_class_id: 999 }],
    discount_amount: 0,
  });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /^Tax /);
});

test("invalid inputs are rejected", () => {
  const cfg = makeConfig();
  assert.equal(computeCartTax({ config: cfg, lines: [], discount_amount: 0 }).ok, false);
  assert.equal(computeCartTax({ config: cfg, lines: [{ key: 1, amount: -1 }], discount_amount: 0 }).ok, false);
  assert.equal(computeCartTax({ config: cfg, lines: [{ key: 1, amount: 10 }], discount_amount: -1 }).ok, false);
});

// ── label, shipping, inclusive ──
test("tax label comes from the rules row and lands in the snapshot", () => {
  const res = ok(
    computeCartTax({
      config: makeConfig({ rules: { tax_label: "Sales Tax" } }),
      lines: [{ key: 1, amount: 100 }],
      discount_amount: 0,
    })
  );
  assert.equal(res.tax_label, "Sales Tax");
  assert.equal(res.snapshot.tax_label, "Sales Tax");
  assert.equal(res.snapshot.version, 1);
});

test("shipping is not taxed by default; taxed when rules.shipping_taxable", () => {
  const off = ok(computeCartTax({ config: makeConfig(), lines: [{ key: 1, amount: 1000 }], discount_amount: 0, shipping_amount: 200 }));
  assert.equal(off.shipping_tax, 0);
  assert.equal(off.vat_amount, 170);
  const on = ok(
    computeCartTax({ config: makeConfig({ rules: { shipping_taxable: true } }), lines: [{ key: 1, amount: 1000 }], discount_amount: 0, shipping_amount: 200 })
  );
  assert.equal(on.shipping_tax, 34);
  assert.equal(on.vat_amount, 204);
});

test("prices_include_tax extracts tax from the line instead of adding it", () => {
  // 1170 inclusive of 17% => net 1000, tax 170
  assert.equal(computeLineTax(1170, 17, { pricesIncludeTax: true }), 170);
  const res = ok(
    computeCartTax({
      config: makeConfig({ rules: { prices_include_tax: true } }),
      lines: [{ key: 1, amount: 1170 }],
      discount_amount: 0,
    })
  );
  assert.equal(res.vat_amount, 170);
});
