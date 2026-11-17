import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { canonicalPkMobile, normaliseEmail, normalisePhone, phoneToE164 } = await import(
  "../lib/customerIdentity.ts"
);

describe("canonicalPkMobile", () => {
  it("normalises PK forms to 03XXXXXXXXX", () => {
    assert.equal(canonicalPkMobile("03331234567"), "03331234567");
    assert.equal(canonicalPkMobile("3331234567"), "03331234567");
    assert.equal(canonicalPkMobile("923331234567"), "03331234567");
    assert.equal(canonicalPkMobile("00923331234567"), "03331234567");
  });
  it("returns null for non-PK", () => {
    assert.equal(canonicalPkMobile("14155552671"), null);
  });
});

describe("normalisePhone", () => {
  it("PK mobile", () => {
    assert.equal(normalisePhone("+92 333 1234567"), "03331234567");
    assert.equal(normalisePhone("0333-1234567"), "03331234567");
  });
  it("non-PK uses +digits marker", () => {
    assert.equal(normalisePhone("+1 (415) 555-2671"), "+14155552671");
  });
  it("rejects implausible", () => {
    assert.equal(normalisePhone("123"), null);
    assert.equal(normalisePhone(""), null);
    assert.equal(normalisePhone(null), null);
  });
});

describe("normaliseEmail", () => {
  it("trim lower", () => {
    assert.equal(normaliseEmail("  Foo@Example.COM "), "foo@example.com");
  });
  it("gmail dots and plus and googlemail", () => {
    assert.equal(normaliseEmail("a.b.c+tag@gmail.com"), "abc@gmail.com");
    assert.equal(normaliseEmail("a.b.c+tag@googlemail.com"), "abc@gmail.com");
  });
  it("non-gmail keeps dots", () => {
    assert.equal(normaliseEmail("a.b+x@outlook.com"), "a.b+x@outlook.com");
  });
  it("rejects bad", () => {
    assert.equal(normaliseEmail("nodomain"), null);
    assert.equal(normaliseEmail("@x.com"), null);
  });
});

describe("phoneToE164", () => {
  it("PK to +92", () => {
    assert.equal(phoneToE164("03331234567"), "+923331234567");
  });
  it("keeps + form", () => {
    assert.equal(phoneToE164("+14155552671"), "+14155552671");
  });
});
