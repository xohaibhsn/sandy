import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { ALLOWED_METHODS_WHEN_PROTECTION_OFF } = await import("../lib/codProtection.ts");

describe("codProtection when protection OFF", () => {
  it("allowedMethods are all four independent of advance_methods", () => {
    assert.deepEqual([...ALLOWED_METHODS_WHEN_PROTECTION_OFF], [
      "cod",
      "jazzcash",
      "easypaisa",
      "bank",
    ]);
  });
});
