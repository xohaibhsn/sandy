/**
 * COD insights pure helpers + CSV (BATCH-64 / D78 / D79).
 * Run: node --test tests/cod-insights.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  buildCodInsights,
  codInsightsCsv,
  csvGuardCell,
  mergeAndSortRows,
  topNWithOther,
  COD_CITY_TOP_N,
} = await import("../lib/codInsights.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function raw(over: Partial<{
  key: string;
  orders: number;
  delivered: number;
  rto: number;
  cancelled: number;
  open: number;
  delivered_revenue: number;
  delivered_revenue_ex_gst: number;
}> = {}) {
  return {
    key: "X",
    orders: 0,
    delivered: 0,
    rto: 0,
    cancelled: 0,
    open: 0,
    delivered_revenue: 0,
    delivered_revenue_ex_gst: 0,
    ...over,
  };
}

describe("buildCodInsights rates", () => {
  it("computes rto_rate and cancel_rate to 1 decimal", () => {
    const out = buildCodInsights({
      by_city: [raw({ key: "Lahore", orders: 10, delivered: 6, rto: 2, cancelled: 1, open: 1 })],
      by_province: [raw({ key: "Punjab", orders: 10, delivered: 6, rto: 2, cancelled: 1, open: 1 })],
      by_payment: [raw({ key: "cod", orders: 10, delivered: 6, rto: 2, cancelled: 1, open: 1 })],
      by_courier: [raw({ key: "TCS", orders: 10, delivered: 6, rto: 2, cancelled: 1, open: 1 })],
      by_zone: [raw({ key: "Lahore", orders: 10, delivered: 6, rto: 2, cancelled: 1, open: 1 })],
    });
    // rto/(delivered+rto) = 2/8 = 25.0
    assert.equal(out.by_city[0].rto_rate, 25);
    // cancelled/orders = 1/10 = 10.0
    assert.equal(out.by_city[0].cancel_rate, 10);
  });

  it("null rates when denominators are 0", () => {
    const out = buildCodInsights({
      by_city: [raw({ key: "Empty", orders: 0, delivered: 0, rto: 0, cancelled: 0, open: 0 })],
      by_province: [],
      by_payment: [raw({ key: "cod", orders: 0 })],
      by_courier: [],
      by_zone: [],
    });
    assert.equal(out.by_city[0].rto_rate, null);
    assert.equal(out.by_city[0].cancel_rate, null);
  });

  it("merges city case/whitespace: 'lahore ' = 'Lahore'", () => {
    const out = buildCodInsights({
      by_city: [
        raw({ key: "Lahore", orders: 3, delivered: 2 }),
        raw({ key: "lahore ", orders: 2, delivered: 1 }),
        raw({ key: "  LAHORE", orders: 1, delivered: 0 }),
      ],
      by_province: [],
      by_payment: [raw({ key: "cod", orders: 6 })],
      by_courier: [],
      by_zone: [],
    });
    assert.equal(out.by_city.length, 1);
    assert.equal(out.by_city[0].orders, 6);
    assert.equal(out.by_city[0].delivered, 3);
    assert.equal(out.by_city[0].key, "Lahore");
  });

  it("sorts by orders desc", () => {
    const out = buildCodInsights({
      by_city: [
        raw({ key: "A", orders: 1 }),
        raw({ key: "B", orders: 5 }),
        raw({ key: "C", orders: 3 }),
      ],
      by_province: [],
      by_payment: [raw({ key: "cod", orders: 9 })],
      by_courier: [],
      by_zone: [],
    });
    assert.deepEqual(
      out.by_city.map((r) => r.key),
      ["B", "C", "A"]
    );
  });

  it("top-25 + Other for city", () => {
    const cities = Array.from({ length: 30 }, (_, i) =>
      raw({ key: `City${String(i).padStart(2, "0")}`, orders: 30 - i, delivered: 1 })
    );
    const out = buildCodInsights({
      by_city: cities,
      by_province: [],
      by_payment: [raw({ key: "cod", orders: cities.reduce((s, r) => s + r.orders, 0) })],
      by_courier: [],
      by_zone: [],
    });
    assert.equal(out.by_city.length, COD_CITY_TOP_N + 1);
    assert.equal(out.by_city[out.by_city.length - 1].key, "Other");
    const otherOrders = cities.slice(COD_CITY_TOP_N).reduce((s, r) => s + r.orders, 0);
    assert.equal(out.by_city[out.by_city.length - 1].orders, otherOrders);
  });
});

describe("codInsightsCsv", () => {
  it("header, LF, escaping quotes/commas/newlines, injection guard", () => {
    // Put injection / quote / newline keys on payment (no whitespace collapse).
    const insights = buildCodInsights({
      by_city: [raw({ key: "Lahore", orders: 4, delivered: 1, delivered_revenue: 100 })],
      by_province: [raw({ key: "Punjab", orders: 4 })],
      by_payment: [
        raw({ key: "=HYPERLINK(1)", orders: 1, delivered: 1, delivered_revenue: 100 }),
        raw({ key: 'Say "Hi", please', orders: 2 }),
        raw({ key: "line\nbreak", orders: 1 }),
      ],
      by_courier: [raw({ key: "Not assigned", orders: 4 })],
      by_zone: [raw({ key: "No zone", orders: 4 })],
    });
    const csv = codInsightsCsv(insights, { preset: "all", from: null, to: null });
    assert.ok(csv.endsWith("\n"));
    assert.equal(csv.includes("\r"), false);
    const header = csv.split("\n")[0];
    assert.equal(
      header,
      "dimension,key,orders,delivered,rto,cancelled,open,rto_rate,cancel_rate,delivered_revenue,delivered_revenue_ex_gst"
    );
    assert.ok(csv.includes("'=HYPERLINK(1)"));
    assert.ok(csv.includes('"Say ""Hi"", please"'));
    assert.match(csv, /"line\nbreak"/);
  });

  it("csvGuardCell prefixes dangerous starters", () => {
    assert.equal(csvGuardCell("=1+1"), "'=1+1");
    assert.equal(csvGuardCell("+cmd"), "'+cmd");
    assert.equal(csvGuardCell("-1"), "'-1");
    assert.equal(csvGuardCell("@sum"), "'@sum");
    assert.equal(csvGuardCell("\tfoo"), "'\tfoo");
    assert.equal(csvGuardCell("safe"), "safe");
  });
});

describe("mergeAndSortRows / topNWithOther", () => {
  it("topNWithOther no-ops when <= N", () => {
    const rows = mergeAndSortRows([raw({ key: "A", orders: 1 })]);
    assert.equal(topNWithOther(rows, 25).length, 1);
  });
});

describe("static panel / API source guards", () => {
  it("CodInsightsPanel has no customer_name/phone/email/address fields", () => {
    const src = readFileSync(
      path.join(repoRoot, "components/admin/CodInsightsPanel.tsx"),
      "utf8"
    );
    for (const bad of [
      "customer_name",
      "customer_phone",
      "customer_email",
      "delivery_address",
      "customer_phone_norm",
    ]) {
      assert.equal(src.includes(bad), false, `panel must not reference ${bad}`);
    }
  });

  it("API only adds cod_insights when include contains the flag (source check)", () => {
    const src = readFileSync(
      path.join(repoRoot, "pages/api/admin-dashboard-summary.ts"),
      "utf8"
    );
    assert.ok(src.includes('include.has("cod_insights")'));
    assert.ok(src.includes("wantCodInsights && cod_insights"));
    assert.ok(src.includes("body.cod_insights"));
  });
});
