/**
 * RECEIPT-PRIVACY-01 — opaque receipt refs + validation (no network).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  formatReceiptRef,
  parseReceiptRef,
  isOpaqueReceiptRef,
  RECEIPT_REF_MAX_LEN,
} = await import("../lib/receiptRef.ts");
const { assertSafeReceiptUrl, assertSafeReceiptRef, UrlValidationError } = await import(
  "../lib/urlValidation.ts"
);

const U = () => "123e4567-e89b-12d3-a456-426614174000";

describe("receiptRef format/parse", () => {
  it("formats and parses cld + loc refs", () => {
    const cld = formatReceiptRef("cld", `receipt-${U()}`, "png");
    assert.equal(cld, `rcpt:v1:cld:receipt-${U()}.png`);
    const p = parseReceiptRef(cld);
    assert.ok(p);
    assert.equal(p!.storage, "cld");
    assert.equal(p!.id, `receipt-${U()}`);
    assert.equal(p!.ext, "png");

    const loc = formatReceiptRef("loc", U(), "pdf");
    assert.equal(loc, `rcpt:v1:loc:${U()}.pdf`);
    assert.equal(parseReceiptRef(loc)?.storage, "loc");
  });

  it("rejects invalid / traversal / length / bad ext", () => {
    const bad = [
      "",
      "rcpt:v1:cld:receipt-x.png",
      `rcpt:v1:loc:receipt-${U()}.png`,
      `rcpt:v1:cld:${U()}.png`,
      `rcpt:v1:cld:receipt-${U()}.gif`,
      `rcpt:v1:cld:receipt-${U()}.php`,
      `rcpt:v1:cld:../receipt-${U()}.png`,
      `rcpt:v1:cld:receipt-${U()}/x.png`,
      `rcpt:v1:cld:receipt-${U()}.png.extra`,
      `rcpt:v1:cld:receipt-${U()}..png`,
      `RCPT:v1:cld:receipt-${U()}.png`,
      `rcpt:v1:cld:receipt-${U().toUpperCase()}.png`,
      `rcpt:v1:evil:receipt-${U()}.png`,
      `rcpt:v1:cld:receipt-${U()}.png` + "a".repeat(200),
    ];
    for (const v of bad) {
      assert.equal(parseReceiptRef(v), null, v);
      assert.equal(isOpaqueReceiptRef(v), false, v);
    }
    assert.ok(RECEIPT_REF_MAX_LEN <= 120);
    const over = `rcpt:v1:loc:${U()}.png` + "x".repeat(100);
    assert.ok(over.length > RECEIPT_REF_MAX_LEN);
    assert.equal(parseReceiptRef(over), null);
  });
});

describe("assertSafeReceiptUrl accepts refs + legacy", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env.CLOUDINARY_CLOUD_NAME;
    process.env.CLOUDINARY_CLOUD_NAME = "sandytestcloud";
  });
  after(() => {
    if (saved === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = saved;
  });

  it("accepts opaque refs", () => {
    const ref = `rcpt:v1:loc:${U()}.jpg`;
    assert.equal(assertSafeReceiptUrl(ref), ref);
    assert.equal(assertSafeReceiptRef(ref), ref);
    const cld = `rcpt:v1:cld:receipt-${U()}.webp`;
    assert.equal(assertSafeReceiptUrl(cld), cld);
  });

  it("accepts legacy local + cloudinary", () => {
    const local = `/uploads/receipts/${U()}.png`;
    assert.equal(assertSafeReceiptUrl(local), local);
    const url = `https://res.cloudinary.com/sandytestcloud/image/upload/v1/sandy/receipts/receipt-${U()}.png`;
    assert.equal(assertSafeReceiptUrl(url), url);
  });

  it("rejects junk", () => {
    const junk = [
      "https://evil.test/x.png",
      "/uploads/receipts/../etc/passwd",
      "rcpt:v1:cld:nope.png",
      "javascript:alert(1)",
      "//res.cloudinary.com/sandytestcloud/image/upload/sandy/receipts/receipt-" + U() + ".png",
    ];
    for (const v of junk) {
      assert.throws(() => assertSafeReceiptUrl(v), UrlValidationError, v);
    }
  });
});
