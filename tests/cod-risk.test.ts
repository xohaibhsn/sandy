import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { evaluateCodRisk, loadCodRiskHistory } = await import("../lib/codRisk.ts");
const { ORDER_PROTECTION_DEFAULTS } = await import("../lib/orderProtectionSettings.ts");

const baseSettings = {
  ...ORDER_PROTECTION_DEFAULTS,
  cod_protection_enabled: true,
};

function hist(partial: Partial<{ deliveredCount: number; cancelledCount: number; refusedCount: number; openCodPendingCount: number }> = {}) {
  return {
    deliveredCount: 0,
    cancelledCount: 0,
    refusedCount: 0,
    openCodPendingCount: 0,
    ...partial,
  };
}

describe("evaluateCodRisk", () => {
  it("blacklist forbids COD and offers advance only", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 1000,
      paymentMethod: "cod",
      history: hist(),
      blacklistHit: true,
      ipOrderCount24h: 0,
      settings: baseSettings,
      otpEffective: false,
    });
    assert.equal(r.codAllowed, false);
    assert.ok(r.reasons.includes("BLACKLIST"));
    assert.equal(r.score, 100);
    assert.deepEqual(r.allowedMethods, ["jazzcash", "easypaisa", "bank"]);
  });

  it("new customer under cap allows COD", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 4000,
      paymentMethod: "cod",
      history: hist(),
      blacklistHit: false,
      ipOrderCount24h: 0,
      settings: baseSettings,
      otpEffective: true,
    });
    assert.equal(r.codAllowed, true);
    assert.equal(r.otpRequired, true);
    assert.ok(r.allowedMethods.includes("cod"));
  });

  it("new customer over cap advance_only forbids COD", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 6000,
      paymentMethod: "cod",
      history: hist(),
      blacklistHit: false,
      ipOrderCount24h: 0,
      settings: { ...baseSettings, cod_risky_mode: "advance_only" },
      otpEffective: false,
    });
    assert.equal(r.codAllowed, false);
    assert.ok(r.reasons.includes("OVER_CAP"));
  });

  it("new customer over cap advance_delivery_charge allows COD with charge", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 6000,
      paymentMethod: "cod",
      history: hist(),
      blacklistHit: false,
      ipOrderCount24h: 0,
      settings: {
        ...baseSettings,
        cod_risky_mode: "advance_delivery_charge",
        cod_advance_delivery_charge: 200,
      },
      otpEffective: false,
    });
    assert.equal(r.codAllowed, true);
    assert.equal(r.advanceDeliveryChargeRequired, true);
    assert.equal(r.advanceDeliveryCharge, 200);
  });

  it("open COD limit forbids COD", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 1000,
      paymentMethod: "cod",
      history: hist({ openCodPendingCount: 1, deliveredCount: 5 }),
      blacklistHit: false,
      ipOrderCount24h: 0,
      settings: baseSettings,
      otpEffective: false,
    });
    assert.equal(r.codAllowed, false);
    assert.ok(r.reasons.includes("OPEN_COD"));
  });

  it("risky threshold advance_only forbids COD", () => {
    const r = evaluateCodRisk({
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 1000,
      paymentMethod: "cod",
      history: hist({ cancelledCount: 3, refusedCount: 2 }),
      blacklistHit: false,
      ipOrderCount24h: 5,
      settings: { ...baseSettings, cod_risk_threshold: 50 },
      otpEffective: false,
    });
    assert.ok(r.score >= 50);
    assert.equal(r.codAllowed, false);
  });

  it("is deterministic", () => {
    const input = {
      phoneNorm: "03331234567",
      emailNorm: "a@b.com",
      orderTotal: 2500,
      paymentMethod: "cod" as const,
      history: hist({ deliveredCount: 1, cancelledCount: 1 }),
      blacklistHit: false,
      ipOrderCount24h: 1,
      settings: baseSettings,
      otpEffective: true,
    };
    assert.deepEqual(evaluateCodRisk(input), evaluateCodRisk(input));
  });
});

describe("loadCodRiskHistory open-COD SQL (D34)", () => {
  it("counts status IN (pending,confirmed) AND payment_method=cod as open", async () => {
    const queries: string[] = [];
    const conn = {
      async query(sql: string) {
        queries.push(sql);
        return [[{ delivered_count: 0, cancelled_count: 0, open_cod: 2 }]];
      },
    };
    const h = await loadCodRiskHistory(conn as never, "03331234567");
    assert.equal(h.openCodPendingCount, 2);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /status IN \('pending','confirmed'\)/);
    assert.match(queries[0], /payment_method = 'cod'/);
    assert.doesNotMatch(queries[0], /status = 'pending'/);
  });
});
