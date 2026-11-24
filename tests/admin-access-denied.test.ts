/**
 * Unit coverage for access_denied audit helper wiring (no network).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const inserts: unknown[][] = [];
const fakePool = {
  async query(sql: string, params?: unknown) {
    const s = String(sql);
    if (s.includes("INFORMATION_SCHEMA") && s.includes("admin_audit_log")) {
      return [[{ ok: 1 }]];
    }
    if (s.includes("INSERT INTO admin_audit_log")) {
      inserts.push(params as unknown[]);
      return [{ affectedRows: 1 }];
    }
    if (s.includes("FROM admin_sessions")) {
      return [[]];
    }
    return [[]];
  },
};
globalThis._mysqlPool = fakePool as never;

const {
  requirePermission,
  requireSessionPermission,
  resetAuditThrottleForTests,
} = await (async () => {
  const perm = await import("../lib/adminPermissions.ts");
  const audit = await import("../lib/auditLog.ts");
  return {
    requirePermission: perm.requirePermission,
    requireSessionPermission: perm.requireSessionPermission,
    resetAuditThrottleForTests: audit.resetAuditThrottleForTests,
  };
})();

function makeRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => unknown;
    json: (b: unknown) => unknown;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("access_denied helpers", () => {
  beforeEach(() => {
    inserts.length = 0;
    resetAuditThrottleForTests();
  });

  it("requireSessionPermission writes access_denied without route/method", async () => {
    const res = makeRes();
    const session = {
      role: "writer" as const,
      name: "W",
      staffId: 42,
      isMaster: false,
      sessionId: 1,
    };
    const ok = requireSessionPermission(session, res as never, "tax:manage");
    assert.equal(ok, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Forbidden" });
    // allow microtask
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(inserts.length >= 1, "audit insert");
    const params = inserts[0];
    assert.equal(params[4], "access_denied");
    assert.equal(params[5], "permission");
    assert.equal(params[6], "tax:manage");
    const detail = JSON.parse(String(params[8]));
    assert.equal(detail.permission, "tax:manage");
    assert.equal("route" in detail, false);
    assert.equal("method" in detail, false);
  });

  it("requireSessionPermission throttle suppresses second row", async () => {
    const session = {
      role: "writer" as const,
      name: "W",
      staffId: 42,
      isMaster: false,
      sessionId: 1,
    };
    const r1 = makeRes();
    requireSessionPermission(session, r1 as never, "tax:manage");
    await new Promise((r) => setTimeout(r, 20));
    const n1 = inserts.length;
    const r2 = makeRes();
    requireSessionPermission(session, r2 as never, "tax:manage");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inserts.length, n1, "throttled");
    assert.deepEqual(r2.body, { error: "Forbidden" });
  });
});

void requirePermission;
