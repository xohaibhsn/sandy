import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { calculateCouponDiscount } = await import("../lib/orderPricing.ts");
const { formatPrice } = await import("../lib/site.ts");

describe("calculateCouponDiscount whole-rupee percentage (D65)", () => {
  it("10% of 999 → 100", () => {
    const r = calculateCouponDiscount(999, "percentage", 10);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.discount_amount, 100);
  });
  it("15% of 1333 → 200", () => {
    const r = calculateCouponDiscount(1333, "percentage", 15);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.discount_amount, 200);
  });
  it("fixed unchanged and capped at base", () => {
    const r = calculateCouponDiscount(500, "fixed", 50);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.discount_amount, 50);
    const cap = calculateCouponDiscount(40, "fixed", 100);
    assert.equal(cap.ok, true);
    if (cap.ok) assert.equal(cap.discount_amount, 40);
    const pctCap = calculateCouponDiscount(50, "percentage", 200);
    assert.equal(pctCap.ok, true);
    if (pctCap.ok) assert.equal(pctCap.discount_amount, 50);
  });
});

describe("formatPrice (D65)", () => {
  it("whole amounts have no decimals", () => {
    assert.equal(formatPrice(999), "Rs. 999");
    assert.equal(formatPrice(1561), "Rs. 1,561");
  });
  it("fractional amounts show exactly 2 decimals", () => {
    assert.equal(formatPrice(99.9), "Rs. 99.90");
  });
});
