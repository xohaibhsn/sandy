/**
 * Finding 67 — receiptKindFromUrl classification (no network).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { receiptKindFromUrl } = await import("../lib/receiptView.ts");

describe("receiptKindFromUrl", () => {
  it("classifies pdf (case-insensitive)", () => {
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.pdf"), "pdf");
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.PDF"), "pdf");
  });

  it("classifies image extensions", () => {
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.png"), "image");
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.jpg"), "image");
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.jpeg"), "image");
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.webp"), "image");
  });

  it("ignores query and hash", () => {
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.pdf?x=1"), "pdf");
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1.png#frag"), "image");
  });

  it("returns unknown for no extension, absolute, javascript, empty", () => {
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1"), "unknown");
    assert.equal(receiptKindFromUrl("https://evil.example/x.pdf"), "unknown");
    assert.equal(receiptKindFromUrl("javascript:alert(1)"), "unknown");
    assert.equal(receiptKindFromUrl(""), "unknown");
    assert.equal(receiptKindFromUrl("   "), "unknown");
  });
});
