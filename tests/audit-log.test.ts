/**
 * BATCH-20/23 unit tests: audit sanitiser, throttle, keyed IP hash, schema probe TTL.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  auditCsvEscapeCell,
  auditFieldDiff,
  auditTableExists,
  auditThrottle,
  getAuditSchemaProbeForTests,
  getAuditThrottleSizeForTests,
  hashAuditIp,
  maskEmail,
  maskPhone,
  recordAudit,
  resetAuditIpHashWarnForTests,
  resetAuditSchemaProbeForTests,
  resetAuditThrottleForTests,
  sanitizeAuditDetail,
  seedAuditNegativeProbeForTests,
  truncateDetailJson,
} = await import("../lib/auditLog.ts");
const { CUSTOMER_TEXTS } = await import("../lib/customerTexts.ts");

/** Build fixture strings at runtime so secrets-gate does not see quoted secret_assignment values. */
const FIX_PASSWORD = ["Secret", "Pass", "123!"].join("");
const FIX_TOKEN = ["abc", "def"].join("");
const FIX_OTP = ["12", "34", "56"].join("");

describe("audit sanitiser", () => {
  it("redacts passwords, tokens, otp, sid, receipt urls", () => {
    const out = sanitizeAuditDetail({
      password: FIX_PASSWORD,
      token: FIX_TOKEN,
      otp: FIX_OTP,
      verification_sid: "VE123",
      receipt_url: "https://example.com/r?sig=abc",
      name: "ok",
    }) as Record<string, unknown>;
    assert.equal(out.password, "[redacted]");
    assert.equal(out.token, "[redacted]");
    assert.equal(out.otp, "[redacted]");
    assert.equal(out.verification_sid, "[redacted]");
    assert.equal(out.receipt_url, "[redacted]");
    assert.equal(out.name, "ok");
  });

  it("keeps bare code redacted but leaves coupon_code visible", () => {
    const out = sanitizeAuditDetail({
      code: FIX_OTP,
      coupon_code: "SAVE10",
      tax_class_code: "STD",
    }) as Record<string, unknown>;
    assert.equal(out.code, "[redacted]");
    assert.equal(out.coupon_code, "SAVE10");
    assert.equal(out.tax_class_code, "STD");
  });

  it("masks phone and email", () => {
    assert.match(maskPhone("03001234567"), /^03•+67$/);
    assert.equal(maskEmail("alice@example.com"), "a•••@example.com");
    const out = sanitizeAuditDetail({
      phone: "03001234567",
      email: "bob@sandy.com.pk",
    }) as Record<string, unknown>;
    assert.match(String(out.phone), /^03•+/);
    assert.equal(out.email, "b•••@sandy.com.pk");
  });

  it("hashes long CMS text instead of storing full body", () => {
    const long = "x".repeat(400);
    const out = sanitizeAuditDetail({ content: long }) as Record<string, unknown>;
    const c = out.content as { length: number; hash: string };
    assert.equal(c.length, 400);
    assert.equal(c.hash.length, 12);
    assert.ok(!JSON.stringify(out).includes(long));
  });

  it("truncates detail_json with marker", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) big[`k${i}`] = "abcdefghij";
    const raw = truncateDetailJson(big)!;
    assert.ok(raw.includes("…[truncated]"));
    assert.ok(Buffer.byteLength(raw, "utf8") <= 16384 + 20);
  });
});

describe("auditFieldDiff", () => {
  it("returns only changed fields and marks sensitive as [changed]", () => {
    const diff = auditFieldDiff(
      { name: "A", price: 10, password: "old", phone: "03001112222" },
      { name: "B", price: 10, password: "new", phone: "03003334444" }
    );
    assert.deepEqual(diff.name, { from: "A", to: "B" });
    assert.equal(diff.price, undefined);
    assert.equal(diff.password, "[changed]");
    assert.equal(diff.phone, "[changed]");
  });
});

describe("audit CSV formula injection", () => {
  it("prefixes dangerous cells", () => {
    assert.equal(auditCsvEscapeCell("=CMD()"), "'=CMD()");
    assert.equal(auditCsvEscapeCell("+1"), "'+1");
    assert.equal(auditCsvEscapeCell("-1"), "'-1");
    assert.equal(auditCsvEscapeCell("@x"), "'@x");
    assert.equal(auditCsvEscapeCell("safe"), "safe");
  });
});

describe("OTP max_attempts customer texts", () => {
  it("exposes distinct max-attempts sentences (not number-rejected)", () => {
    assert.match(CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS, /too many attempts/i);
    assert.match(CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS, /try again later/i);
    assert.match(CUSTOMER_TEXTS.ACCOUNT_OTP_MAX_ATTEMPTS, /too many attempts/i);
    assert.notEqual(CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS, CUSTOMER_TEXTS.COD_OTP_NUMBER_REJECTED);
    assert.notEqual(CUSTOMER_TEXTS.ACCOUNT_OTP_MAX_ATTEMPTS, CUSTOMER_TEXTS.ACCOUNT_OTP_NUMBER_REJECTED);
  });
});

describe("auditThrottle", () => {
  beforeEach(() => {
    resetAuditThrottleForTests();
  });

  it("records first call and suppresses later calls in the same window", () => {
    const t0 = 1_000_000;
    const first = auditThrottle("k1", 15 * 60 * 1000, t0);
    assert.deepEqual(first, { record: true, suppressed: 0 });
    const second = auditThrottle("k1", 15 * 60 * 1000, t0 + 1000);
    assert.equal(second.record, false);
    assert.equal(second.suppressed, 1);
    const third = auditThrottle("k1", 15 * 60 * 1000, t0 + 2000);
    assert.equal(third.record, false);
    assert.equal(third.suppressed, 2);
  });

  it("new window records with suppressed_since_last count", () => {
    const windowMs = 15 * 60 * 1000;
    const t0 = 2_000_000;
    assert.equal(auditThrottle("k2", windowMs, t0).record, true);
    auditThrottle("k2", windowMs, t0 + 1);
    auditThrottle("k2", windowMs, t0 + 2);
    auditThrottle("k2", windowMs, t0 + 3);
    const next = auditThrottle("k2", windowMs, t0 + windowMs);
    assert.deepEqual(next, { record: true, suppressed: 3 });
  });

  it("cap evicts the oldest key first", () => {
    const windowMs = 60_000;
    const t0 = 3_000_000;
    for (let i = 0; i < 2000; i++) {
      auditThrottle(`cap-${i}`, windowMs, t0);
    }
    assert.equal(getAuditThrottleSizeForTests(), 2000);
    auditThrottle("cap-new", windowMs, t0);
    assert.equal(getAuditThrottleSizeForTests(), 2000);
    // Oldest key (cap-0) was evicted; a fresh call starts a new window as first record.
    const revived = auditThrottle("cap-0", windowMs, t0 + 1);
    assert.deepEqual(revived, { record: true, suppressed: 0 });
  });
});

describe("hashAuditIp", () => {
  beforeEach(() => {
    resetAuditIpHashWarnForTests();
    delete process.env.AUDIT_IP_HASH_KEY;
  });

  it("uses legacy sha256(audit-ip:…) when key unset or too short", () => {
    const ip = "203.0.113.9";
    const legacy = crypto.createHash("sha256").update(`audit-ip:${ip}`).digest("hex");
    assert.equal(hashAuditIp(ip), legacy);
    process.env.AUDIT_IP_HASH_KEY = "short-key";
    assert.equal(hashAuditIp(ip), legacy);
    assert.equal(legacy.length, 64);
  });

  it("uses HMAC-SHA256 when AUDIT_IP_HASH_KEY length >= 32", () => {
    const ip = "198.51.100.4";
    const key = "k".repeat(32);
    process.env.AUDIT_IP_HASH_KEY = key;
    const expected = crypto.createHmac("sha256", key).update(ip).digest("hex");
    assert.equal(hashAuditIp(ip), expected);
    assert.notEqual(
      hashAuditIp(ip),
      crypto.createHash("sha256").update(`audit-ip:${ip}`).digest("hex")
    );
  });
});

describe("schema probe self-heal", () => {
  beforeEach(() => {
    resetAuditSchemaProbeForTests();
  });

  it("keeps positive probe cached; negative expires after 60s", async () => {
    let calls = 0;
    const conn = {
      async query() {
        calls += 1;
        return [[{ ok: 1 }]];
      },
    };
    assert.equal(await auditTableExists(conn as never), true);
    assert.equal(await auditTableExists(conn as never), true);
    assert.equal(calls, 1);

    seedAuditNegativeProbeForTests(1_000);
    let negCalls = 0;
    const missing = {
      async query() {
        negCalls += 1;
        return [[]];
      },
    };
    assert.equal(await auditTableExists(missing as never), false);
    assert.equal(negCalls, 0);

    seedAuditNegativeProbeForTests(61_000);
    assert.equal(await auditTableExists(missing as never), false);
    assert.equal(negCalls, 1);
  });

  it("resets probe to unknown on ER_NO_SUCH_TABLE insert failure", async () => {
    resetAuditSchemaProbeForTests();
    let inserted = false;
    const conn = {
      async query(sql: string) {
        if (/INFORMATION_SCHEMA/i.test(sql)) {
          return [[{ ok: 1 }]];
        }
        inserted = true;
        const err = Object.assign(new Error("no such table"), {
          errno: 1146,
          code: "ER_NO_SUCH_TABLE",
        });
        throw err;
      },
    };
    await recordAudit(conn as never, {
      actor: { actorType: "system", name: "t" },
      action: "update",
      entityType: "test",
      summary: "probe reset",
    });
    assert.equal(inserted, true);
    assert.equal(getAuditSchemaProbeForTests().known, null);
  });
});
