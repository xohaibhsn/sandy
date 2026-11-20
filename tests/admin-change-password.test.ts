/**
 * ADMIN-LOGIN-02 unit tests: password-change validation helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  ADMIN_NEW_PASSWORD_MAX,
  ADMIN_NEW_PASSWORD_MIN,
  MASTER_ACCOUNT_SECURITY_WARNING,
  MASTER_PASSWORD_HOSTING_MESSAGE,
  validateAdminPasswordChangeInput,
  validatePasswordChangeForm,
} = await import("../lib/adminChangePassword.ts");

describe("admin change-password constants", () => {
  it("exports length bounds and master copy", () => {
    assert.equal(ADMIN_NEW_PASSWORD_MIN, 12);
    assert.equal(ADMIN_NEW_PASSWORD_MAX, 200);
    assert.equal(
      MASTER_PASSWORD_HOSTING_MESSAGE,
      "The master password is managed in hosting settings."
    );
    assert.equal(
      MASTER_ACCOUNT_SECURITY_WARNING,
      "You are signed in with the shared master admin login. Create your own super_admin account under Staff Users, then remove ADMIN_PASSWORD from hosting settings."
    );
  });
});

describe("validateAdminPasswordChangeInput", () => {
  it("rejects missing fields", () => {
    const r = validateAdminPasswordChangeInput({});
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /required/i);
  });

  it("rejects too-short new password", () => {
    const r = validateAdminPasswordChangeInput({
      currentPassword: "old-password-ok",
      newPassword: "short",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at least 12/i);
  });

  it("rejects too-long new password", () => {
    const r = validateAdminPasswordChangeInput({
      currentPassword: "old-password-ok",
      newPassword: "x".repeat(201),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at most 200/i);
  });

  it("rejects new password equal to current", () => {
    const same = "SamePassword12";
    const r = validateAdminPasswordChangeInput({
      currentPassword: same,
      newPassword: same,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /different/i);
  });

  it("accepts valid pair", () => {
    const r = validateAdminPasswordChangeInput({
      currentPassword: "CurrentPass12",
      newPassword: "BrandNewPass99",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.currentPassword, "CurrentPass12");
      assert.equal(r.newPassword, "BrandNewPass99");
    }
  });
});

describe("validatePasswordChangeForm", () => {
  it("requires all fields", () => {
    assert.match(String(validatePasswordChangeForm("", "a", "a")), /required/i);
  });

  it("requires confirm match", () => {
    const err = validatePasswordChangeForm(
      "CurrentPass12",
      "BrandNewPass99",
      "BrandNewPass98"
    );
    assert.match(String(err), /confirmation|match/i);
  });

  it("returns null when valid", () => {
    assert.equal(
      validatePasswordChangeForm("CurrentPass12", "BrandNewPass99", "BrandNewPass99"),
      null
    );
  });
});
