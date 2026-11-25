import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  validateCheckoutContact,
  isValidCheckoutEmail,
  checkoutErrorMessage,
  CHECKOUT_ERR_PHONE,
} = await import("../lib/checkoutValidation.ts");

describe("validateCheckoutContact", () => {
  const base = {
    name: "Ahmed Khan",
    phone: "03001234567",
    email: "ahmed@example.com",
    address: "House 1",
    city: "Lahore",
    province: "Punjab",
  };

  it("accepts valid PK mobiles and email", () => {
    for (const phone of ["03001234567", "+923001234567", "923001234567", "3001234567"]) {
      assert.equal(validateCheckoutContact({ ...base, phone }).ok, true, phone);
    }
  });

  it("rejects invalid phones", () => {
    const a = validateCheckoutContact({ ...base, phone: "12" });
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.field, "phone");
    assert.equal(validateCheckoutContact({ ...base, phone: "0421234567" }).ok, false);
    const b = validateCheckoutContact({ ...base, phone: "" });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.field, "phone");
  });

  it("rejects bad emails and empty province", () => {
    const a = validateCheckoutContact({ ...base, email: "bad" });
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.field, "email");
    const b = validateCheckoutContact({ ...base, province: "" });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.field, "province");
    const c = validateCheckoutContact({ ...base, province: "California" });
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.code, "invalid_province");
  });

  it("isValidCheckoutEmail rules", () => {
    assert.equal(isValidCheckoutEmail("a@b.co"), true);
    assert.equal(isValidCheckoutEmail("bad"), false);
    assert.equal(isValidCheckoutEmail("a@nodot"), false);
    assert.equal(isValidCheckoutEmail("a b@c.com"), false);
  });

  it("checkoutErrorMessage defaults", () => {
    assert.equal(checkoutErrorMessage("invalid_phone"), CHECKOUT_ERR_PHONE);
  });
});
