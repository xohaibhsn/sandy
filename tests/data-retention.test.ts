/**
 * HARDEN-01: data retention purge unit tests (fake pool, no network).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  maybePurgeStaleRows,
  resetDataRetentionThrottleForTests,
  RETENTION_DAYS,
} = await import("../lib/dataRetention.ts");
const { resetAuditSchemaProbeForTests } = await import("../lib/auditLog.ts");

type SqlCall = { sql: string; params?: unknown };

function makeFakePool(opts: {
  failCheckout?: boolean;
  failOtp?: boolean;
  failAudit?: boolean;
  checkoutAffected?: number;
  otpAffected?: number;
}) {
  const calls: SqlCall[] = [];
  const audits: unknown[] = [];
  const pool = {
    async query(sql: string, params?: unknown) {
      calls.push({ sql, params });
      const s = String(sql);
      if (s.includes("DELETE FROM order_checkout_attempts")) {
        if (opts.failCheckout) throw new Error("checkout delete boom");
        return [{ affectedRows: opts.checkoutAffected ?? 0 }];
      }
      if (s.includes("DELETE FROM otp_challenges")) {
        if (opts.failOtp) throw new Error("otp delete boom");
        return [{ affectedRows: opts.otpAffected ?? 0 }];
      }
      if (s.includes("INSERT INTO admin_audit_log") || s.includes("admin_audit_log")) {
        if (opts.failAudit) throw new Error("audit boom");
        audits.push(params);
        return [{ affectedRows: 1 }];
      }
      if (s.includes("INFORMATION_SCHEMA") || s.includes("admin_audit_log")) {
        return [[{ TABLE_NAME: "admin_audit_log" }]];
      }
      return [[]];
    },
  };
  return { pool, calls, audits };
}

describe("maybePurgeStaleRows", () => {
  beforeEach(() => {
    resetDataRetentionThrottleForTests();
    resetAuditSchemaProbeForTests();
  });

  it("throttles: second call within 6h runs no SQL", async () => {
    const { pool, calls } = makeFakePool({ checkoutAffected: 0, otpAffected: 0 });
    const t0 = 1_700_000_000_000;
    await maybePurgeStaleRows(pool as never, t0);
    const afterFirst = calls.length;
    assert.ok(afterFirst >= 1);
    await maybePurgeStaleRows(pool as never, t0 + 60_000);
    assert.equal(calls.length, afterFirst, "throttled call must not run SQL");
  });

  it("SQL uses NOW() - INTERVAL 30 DAY and LIMIT 500", async () => {
    const { pool, calls } = makeFakePool({});
    await maybePurgeStaleRows(pool as never, Date.now());
    const deletes = calls.filter((c) => c.sql.includes("DELETE FROM"));
    assert.equal(deletes.length, 2);
    for (const d of deletes) {
      assert.ok(d.sql.includes(`NOW() - INTERVAL ${RETENTION_DAYS} DAY`));
      assert.ok(d.sql.includes("LIMIT 500"));
    }
    assert.ok(
      deletes.some((d) => d.sql.includes("order_checkout_attempts"))
    );
    assert.ok(deletes.some((d) => d.sql.includes("otp_challenges")));
  });

  it("swallows errors and does not throw", async () => {
    const { pool } = makeFakePool({ failCheckout: true, failOtp: true });
    await assert.doesNotReject(() =>
      maybePurgeStaleRows(pool as never, Date.now())
    );
  });

  it("writes audit only when n>0 with only the two counts", async () => {
    // recordAudit probes schema then inserts — stub via real module by mocking query broadly
    const calls: SqlCall[] = [];
    let auditDetail: unknown = null;
    const pool = {
      async query(sql: string, params?: unknown) {
        calls.push({ sql, params });
        const s = String(sql);
        if (s.includes("DELETE FROM order_checkout_attempts")) {
          return [{ affectedRows: 3 }];
        }
        if (s.includes("DELETE FROM otp_challenges")) {
          return [{ affectedRows: 2 }];
        }
        if (s.includes("INFORMATION_SCHEMA") && s.includes("admin_audit_log")) {
          return [[{ c: 1 }]];
        }
        if (s.includes("INSERT INTO admin_audit_log")) {
          // detail_json is a positional arg — find object-like JSON
          const arr = params as unknown[];
          const detailRaw = arr.find(
            (p) => typeof p === "string" && p.includes("checkout_attempts")
          );
          auditDetail = detailRaw ? JSON.parse(String(detailRaw)) : null;
          return [{ affectedRows: 1 }];
        }
        return [[{ c: 1 }]];
      },
    };
    await maybePurgeStaleRows(pool as never, Date.now());
    assert.ok(auditDetail);
    const d = auditDetail as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).sort(), [
      "checkout_attempts",
      "otp_challenges",
    ]);
    assert.equal(d.checkout_attempts, 3);
    assert.equal(d.otp_challenges, 2);

    resetDataRetentionThrottleForTests();
    auditDetail = null;
    const poolZero = {
      async query(sql: string) {
        if (sql.includes("DELETE FROM")) return [{ affectedRows: 0 }];
        if (sql.includes("INFORMATION_SCHEMA")) return [[{ c: 1 }]];
        if (sql.includes("INSERT INTO admin_audit_log")) {
          auditDetail = "UNEXPECTED";
          return [{ affectedRows: 1 }];
        }
        return [[]];
      },
    };
    await maybePurgeStaleRows(poolZero as never, Date.now() + 1);
    assert.equal(auditDetail, null, "no audit when nothing deleted");
  });
});
