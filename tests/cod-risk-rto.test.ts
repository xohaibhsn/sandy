/**
 * BATCH-12 CRITICAL SAFETY: loadCodRiskHistory keeps its primary SELECT byte-identical and adds a
 * SEPARATE refused-count query that runs ONLY when orders.rto exists (cached INFORMATION_SCHEMA probe).
 * Mock-based (no database). Run: node --test tests/cod-risk-rto.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { evaluateCodRisk, loadCodRiskHistory, resetRtoColumnCache } = await import("../lib/codRisk.ts");
const { ORDER_PROTECTION_DEFAULTS } = await import("../lib/orderProtectionSettings.ts");

/** The primary history SELECT exactly as it was before BATCH-12 (line endings normalised). */
const PRIMARY_SQL = `SELECT
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
         SUM(CASE WHEN status IN ('pending','confirmed') AND payment_method = 'cod' THEN 1 ELSE 0 END) AS open_cod
       FROM orders
       WHERE customer_phone_norm = ?`;

const PHONE = "03331234567";
const norm = (s: string) => s.replace(/\r\n/g, "\n");

type Call = { sql: string; params: unknown[] | undefined };

function makeConn(opts: {
  rtoColumn?: boolean;
  probeThrows?: boolean;
  refusedThrows?: boolean;
  refused?: number;
  primaryThrows?: boolean;
}) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/INFORMATION_SCHEMA/.test(sql)) {
        if (opts.probeThrows) throw new Error("probe boom");
        return [opts.rtoColumn ? [{ COLUMN_NAME: "rto" }] : []];
      }
      if (/refused_count/.test(sql)) {
        if (opts.refusedThrows) throw new Error("refused boom");
        return [[{ refused_count: opts.refused ?? 0 }]];
      }
      if (opts.primaryThrows) throw new Error("primary boom");
      return [[{ delivered_count: "3", cancelled_count: "2", open_cod: "1" }]];
    },
  };
}

beforeEach(() => {
  resetRtoColumnCache();
});

describe("loadCodRiskHistory primary SELECT is byte-identical", () => {
  it("first query is the unchanged primary SELECT with the phone param", async () => {
    const conn = makeConn({ rtoColumn: false });
    await loadCodRiskHistory(conn as never, PHONE);
    assert.equal(norm(conn.calls[0].sql), PRIMARY_SQL);
    assert.deepEqual(conn.calls[0].params, [PHONE]);
  });

  it("refusedCount never comes from the primary query (stays 0 without the rto column)", async () => {
    const conn = makeConn({ rtoColumn: false });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.deepEqual(h, { deliveredCount: 3, cancelledCount: 2, refusedCount: 0, openCodPendingCount: 1 });
  });
});

describe("0001-0008 database (orders.rto absent)", () => {
  it("only the primary query and the read-only probe run; no refused query", async () => {
    const conn = makeConn({ rtoColumn: false });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.equal(conn.calls.length, 2);
    assert.match(conn.calls[1].sql, /INFORMATION_SCHEMA\.COLUMNS/);
    assert.match(conn.calls[1].sql, /TABLE_SCHEMA = DATABASE\(\)/);
    assert.equal(conn.calls.filter((c) => /refused_count/.test(c.sql)).length, 0);
    assert.equal(h.refusedCount, 0);
  });

  it("negative probe is cached for 30s then re-checked", async () => {
    let now = 1_000_000;
    const spy = mock.method(Date, "now", () => now);
    try {
      const conn = makeConn({ rtoColumn: false });
      await loadCodRiskHistory(conn as never, PHONE);
      await loadCodRiskHistory(conn as never, PHONE);
      now += 29_000;
      await loadCodRiskHistory(conn as never, PHONE);
      const probes = () => conn.calls.filter((c) => /INFORMATION_SCHEMA/.test(c.sql)).length;
      assert.equal(probes(), 1, "no re-probe inside 30s");
      now += 2_000; // 31s after the first negative result
      await loadCodRiskHistory(conn as never, PHONE);
      assert.equal(probes(), 2, "re-probed after 30s");
    } finally {
      spy.mock.restore();
    }
  });

  it("column appears later (migration applied): picked up after the negative window", async () => {
    let now = 5_000_000;
    const spy = mock.method(Date, "now", () => now);
    try {
      const before = makeConn({ rtoColumn: false });
      assert.equal((await loadCodRiskHistory(before as never, PHONE)).refusedCount, 0);
      now += 31_000;
      const after = makeConn({ rtoColumn: true, refused: 2 });
      assert.equal((await loadCodRiskHistory(after as never, PHONE)).refusedCount, 2);
    } finally {
      spy.mock.restore();
    }
  });
});

describe("0009 database (orders.rto present)", () => {
  it("runs a SEPARATE refused query and merges only refusedCount", async () => {
    const conn = makeConn({ rtoColumn: true, refused: 2 });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.deepEqual(h, { deliveredCount: 3, cancelledCount: 2, refusedCount: 2, openCodPendingCount: 1 });
    assert.equal(conn.calls.length, 3);
    assert.equal(norm(conn.calls[0].sql), PRIMARY_SQL, "primary still first and unchanged");
    const refused = conn.calls[2];
    assert.match(refused.sql, /SELECT COUNT\(\*\) AS refused_count FROM orders/);
    assert.match(refused.sql, /customer_phone_norm = \?/);
    assert.match(refused.sql, /rto = 1/);
    assert.deepEqual(refused.params, [PHONE]);
    assert.doesNotMatch(refused.sql, /status/);
  });

  it("positive probe is cached forever (no second INFORMATION_SCHEMA query)", async () => {
    let now = 9_000_000;
    const spy = mock.method(Date, "now", () => now);
    try {
      const conn = makeConn({ rtoColumn: true, refused: 1 });
      await loadCodRiskHistory(conn as never, PHONE);
      now += 10 * 60_000;
      await loadCodRiskHistory(conn as never, PHONE);
      assert.equal(conn.calls.filter((c) => /INFORMATION_SCHEMA/.test(c.sql)).length, 1);
      assert.equal(conn.calls.filter((c) => /refused_count/.test(c.sql)).length, 2);
    } finally {
      spy.mock.restore();
    }
  });

  it("probe failure zeroes ONLY refusedCount", async () => {
    const conn = makeConn({ probeThrows: true });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.deepEqual(h, { deliveredCount: 3, cancelledCount: 2, refusedCount: 0, openCodPendingCount: 1 });
  });

  it("refused-query failure zeroes ONLY refusedCount", async () => {
    const conn = makeConn({ rtoColumn: true, refusedThrows: true });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.deepEqual(h, { deliveredCount: 3, cancelledCount: 2, refusedCount: 0, openCodPendingCount: 1 });
  });

  it("primary failure keeps the original all-zero fallback and never probes", async () => {
    const conn = makeConn({ rtoColumn: true, primaryThrows: true, refused: 5 });
    const h = await loadCodRiskHistory(conn as never, PHONE);
    assert.deepEqual(h, { deliveredCount: 0, cancelledCount: 0, refusedCount: 0, openCodPendingCount: 0 });
    assert.equal(conn.calls.length, 1);
  });

  it("no phone => zeros without any query", async () => {
    const conn = makeConn({ rtoColumn: true });
    const h = await loadCodRiskHistory(conn as never, null);
    assert.deepEqual(h, { deliveredCount: 0, cancelledCount: 0, refusedCount: 0, openCodPendingCount: 0 });
    assert.equal(conn.calls.length, 0);
  });
});

describe("RTO count feeds the existing REFUSED_HISTORY scoring (unchanged)", () => {
  const settings = { ...ORDER_PROTECTION_DEFAULTS, cod_protection_enabled: true };
  const base = {
    phoneNorm: PHONE,
    emailNorm: null,
    orderTotal: 1000,
    paymentMethod: "cod",
    blacklistHit: false,
    ipOrderCount24h: 0,
    settings,
    otpEffective: false,
  };
  const hist = (refusedCount: number) => ({ deliveredCount: 1, cancelledCount: 0, refusedCount, openCodPendingCount: 0 });

  it("adds 15 per refused order, capped at 2", () => {
    const zero = evaluateCodRisk({ ...base, history: hist(0) });
    const one = evaluateCodRisk({ ...base, history: hist(1) });
    const five = evaluateCodRisk({ ...base, history: hist(5) });
    assert.equal(one.score - zero.score, 15);
    assert.equal(five.score - zero.score, 30);
    assert.ok(one.reasons.includes("REFUSED_HISTORY"));
    assert.ok(!zero.reasons.includes("REFUSED_HISTORY"));
  });
});
