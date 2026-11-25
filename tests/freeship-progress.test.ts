import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { computeShippingAmount, shippableSubtotalAfterDiscount } = await import(
  "../lib/shipping.ts"
);

describe("free-shipping progress maths", () => {
  it("below / at / above free_min", () => {
    const zone = { rate: 200, free_min: 2000 };
    const below = computeShippingAmount({
      zone,
      shippableGoodsSubtotalAfterDiscount: 999,
    });
    assert.equal(below, 200);
    const at = computeShippingAmount({
      zone,
      shippableGoodsSubtotalAfterDiscount: 2000,
    });
    assert.equal(at, 0);
    const above = computeShippingAmount({
      zone,
      shippableGoodsSubtotalAfterDiscount: 2997,
    });
    assert.equal(above, 0);
  });

  it("after-discount base used for threshold", () => {
    const base = shippableSubtotalAfterDiscount({
      lines: [{ price: 999, quantity: 3, shippable: true }],
      discountAmount: 300,
      goodsSubtotal: 2997,
    });
    assert.equal(base, 2697);
    const amount = computeShippingAmount({
      zone: { rate: 200, free_min: 2000 },
      shippableGoodsSubtotalAfterDiscount: base,
    });
    assert.equal(amount, 0);
  });
});
