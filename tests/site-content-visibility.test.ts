import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  INTERNAL_SITE_CONTENT_KEYS,
  filterSiteContentForPublic,
  isInternalSiteContentKey,
} = await import("../lib/siteContentVisibility.ts");

describe("INTERNAL_SITE_CONTENT_KEYS filter", () => {
  it("has 13 keys", () => {
    assert.equal(INTERNAL_SITE_CONTENT_KEYS.length, 13);
    assert.equal(isInternalSiteContentKey("cod_otp_enabled"), true);
    assert.equal(isInternalSiteContentKey("shipping_enabled"), false);
  });

  it("anonymous drops internal keys; staff keeps all", () => {
    const content: Record<string, string> = {
      shipping_enabled: "1",
      accounts_enabled: "1",
      cod_otp_enabled: "1",
      advance_only: "0",
      cart_title: "Cart",
    };
    const anon = filterSiteContentForPublic(content, { isStaff: false });
    assert.equal("cod_otp_enabled" in anon, false);
    assert.equal("advance_only" in anon, false);
    assert.equal(anon.shipping_enabled, "1");
    assert.equal(anon.cart_title, "Cart");
    const staff = filterSiteContentForPublic(content, { isStaff: true });
    assert.equal(staff.cod_otp_enabled, "1");
    assert.equal(Object.keys(staff).length, Object.keys(content).length);
  });
});
