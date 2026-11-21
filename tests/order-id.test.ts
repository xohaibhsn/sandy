/**
 * HARDEN-01: order id generator unit tests.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  nextOrderId,
  setOrderIdClockForTests,
  resetOrderIdStateForTests,
} = await import("../lib/orderId.ts");

describe("nextOrderId", () => {
  beforeEach(() => {
    resetOrderIdStateForTests();
    setOrderIdClockForTests(null);
  });

  it("uses ORD-<ms> format", () => {
    setOrderIdClockForTests(() => 1_700_000_000_000);
    assert.equal(nextOrderId(), "ORD-1700000000000");
  });

  it("is strictly increasing even when clock stalls", () => {
    setOrderIdClockForTests(() => 1000);
    const a = nextOrderId();
    const b = nextOrderId();
    const c = nextOrderId();
    assert.equal(a, "ORD-1000");
    assert.equal(b, "ORD-1001");
    assert.equal(c, "ORD-1002");
  });
});
