/**
 * Finding 67 / 73 — receiptKindFromUrl classification (no network).
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

  it("returns unknown for no extension, javascript, empty", () => {
    assert.equal(receiptKindFromUrl("/api/admin-receipt/ORD-1"), "unknown");
    assert.equal(receiptKindFromUrl("javascript:alert(1)"), "unknown");
    assert.equal(receiptKindFromUrl(""), "unknown");
    assert.equal(receiptKindFromUrl("   "), "unknown");
  });

  it("Finding 73: protocol-relative and non-https schemes are unknown", () => {
    assert.equal(receiptKindFromUrl("//evil/x.pdf"), "unknown");
    assert.equal(receiptKindFromUrl("http://x/y.png"), "unknown");
    assert.equal(receiptKindFromUrl("data:image/png;base64,AA"), "unknown");
  });

  it("Finding 73: https absolute URLs classified by extension", () => {
    assert.equal(receiptKindFromUrl("https://x/y.png"), "image");
    assert.equal(receiptKindFromUrl("https://x/y.pdf"), "pdf");
  });
});
