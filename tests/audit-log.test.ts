/**
 * BATCH-20 unit tests: audit sanitiser, diff helper, CSV guard, OTP max-attempts texts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  auditCsvEscapeCell,
  auditFieldDiff,
  maskEmail,
  maskPhone,
  sanitizeAuditDetail,
  truncateDetailJson,
} = await import("../lib/auditLog.ts");
const { CUSTOMER_TEXTS } = await import("../lib/customerTexts.ts");

describe("audit sanitiser", () => {
  it("redacts passwords, tokens, otp, sid, receipt urls", () => {
    const out = sanitizeAuditDetail({
      password: "SecretPass123!",
      token: "abcdef",
      otp: "123456",
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
