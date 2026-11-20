/**
 * ADMIN-LOGIN-01 unit tests: login guard thresholds, lock expiry (injected clock),
 * cap eviction, success clears; timing-safe digest helper.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  ADMIN_LOGIN_GUARD_CAP,
  ADMIN_LOGIN_GUARD_KEY_A_MAX_FAILURES,
  ADMIN_LOGIN_GUARD_KEY_B_MAX_FAILURES,
  ADMIN_LOGIN_GUARD_LOCK_MS,
  ADMIN_LOGIN_GUARD_WINDOW_MS,
  checkAdminLoginGuard,
  clearAdminLoginGuard,
  getAdminLoginGuardSizeForTests,
  recordAdminLoginFailure,
  resetAdminLoginGuardForTests,
  timingSafeEqualDigest,
  timingSafeEqualSha256OfStrings,
} = await import("../lib/adminLoginGuard.ts");

beforeEach(() => {
  resetAdminLoginGuardForTests();
});

describe("timingSafeEqualDigest", () => {
  it("true for equal digests", () => {
    const h = crypto.createHash("sha256").update("same").digest("hex");
    assert.equal(timingSafeEqualDigest(h, h), true);
  });

  it("false for unequal equal-length digests", () => {
    const a = crypto.createHash("sha256").update("a").digest("hex");
    const b = crypto.createHash("sha256").update("b").digest("hex");
    assert.equal(a.length, b.length);
    assert.equal(timingSafeEqualDigest(a, b), false);
  });

  it("false for different lengths", () => {
    assert.equal(timingSafeEqualDigest("abcd", "ab"), false);
    assert.equal(timingSafeEqualDigest("", "ab"), false);
  });
});

describe("timingSafeEqualSha256OfStrings", () => {
  it("true when strings equal", () => {
    assert.equal(timingSafeEqualSha256OfStrings("pw-one", "pw-one"), true);
  });

  it("false when strings differ", () => {
    assert.equal(timingSafeEqualSha256OfStrings("pw-one", "pw-two"), false);
  });
});

describe("admin login guard", () => {
  it("exports named constants", () => {
    assert.equal(ADMIN_LOGIN_GUARD_KEY_A_MAX_FAILURES, 5);
    assert.equal(ADMIN_LOGIN_GUARD_KEY_B_MAX_FAILURES, 20);
    assert.equal(ADMIN_LOGIN_GUARD_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(ADMIN_LOGIN_GUARD_LOCK_MS, 15 * 60 * 1000);
    assert.equal(ADMIN_LOGIN_GUARD_CAP, 5000);
  });

  it("locks key A after 5 failures for username+IP; unlocks after injected lock window", () => {
    const user = "GuardUser@Example.Test";
    const ip = "198.51.100.10";
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 4; i++) {
      recordAdminLoginFailure({ username: user, clientIp: ip, now: t0 + i });
      assert.equal(checkAdminLoginGuard({ username: user, clientIp: ip, now: t0 + i }).locked, false);
    }
    recordAdminLoginFailure({ username: user, clientIp: ip, now: t0 + 4 });
    assert.equal(checkAdminLoginGuard({ username: user, clientIp: ip, now: t0 + 5 }).locked, true);

    // Different IP not locked by key A alone (until key B threshold)
    assert.equal(
      checkAdminLoginGuard({ username: user, clientIp: "198.51.100.99", now: t0 + 5 }).locked,
      false
    );

    // Still locked just before expiry
    assert.equal(
      checkAdminLoginGuard({
        username: user,
        clientIp: ip,
        now: t0 + 4 + ADMIN_LOGIN_GUARD_LOCK_MS - 1,
      }).locked,
      true
    );
    // Unlocked after lock window from the failure that set lockedUntil
    assert.equal(
      checkAdminLoginGuard({
        username: user,
        clientIp: ip,
        now: t0 + 4 + ADMIN_LOGIN_GUARD_LOCK_MS,
      }).locked,
      false
    );
  });

  it("locks key B after 20 failures for username across IPs", () => {
    const user = "spread@example.test";
    const t0 = 1_700_100_000_000;
    for (let i = 0; i < ADMIN_LOGIN_GUARD_KEY_B_MAX_FAILURES; i++) {
      recordAdminLoginFailure({
        username: user,
        clientIp: `203.0.113.${i + 1}`,
        now: t0 + i,
      });
    }
    assert.equal(
      checkAdminLoginGuard({ username: user, clientIp: "203.0.113.250", now: t0 + 100 }).locked,
      true
    );
  });

  it("success clear removes key A and key B", () => {
    const user = "clear.me@example.test";
    const ip = "192.0.2.55";
    const t0 = 1_700_200_000_000;
    for (let i = 0; i < 5; i++) {
      recordAdminLoginFailure({ username: user, clientIp: ip, now: t0 + i });
    }
    assert.equal(checkAdminLoginGuard({ username: user, clientIp: ip, now: t0 + 10 }).locked, true);
    clearAdminLoginGuard({ username: user, clientIp: ip });
    assert.equal(checkAdminLoginGuard({ username: user, clientIp: ip, now: t0 + 11 }).locked, false);
  });

  it("cap eviction removes oldest keys", () => {
    const t0 = 1_700_300_000_000;
    for (let i = 0; i < ADMIN_LOGIN_GUARD_CAP; i++) {
      recordAdminLoginFailure({
        username: `cap-user-${i}@t.invalid`,
        clientIp: "198.51.100.1",
        now: t0,
      });
    }
    assert.ok(getAdminLoginGuardSizeForTests() <= ADMIN_LOGIN_GUARD_CAP);
    // One more unique key forces eviction of oldest
    recordAdminLoginFailure({
      username: "cap-new@t.invalid",
      clientIp: "198.51.100.1",
      now: t0 + 1,
    });
    assert.ok(getAdminLoginGuardSizeForTests() <= ADMIN_LOGIN_GUARD_CAP);
    // First username's key B may have been evicted — not locked from empty state
    const first = checkAdminLoginGuard({
      username: "cap-user-0@t.invalid",
      clientIp: "198.51.100.2",
      now: t0 + 2,
    });
    // After eviction, a fresh check without prior failures is unlocked
    assert.equal(first.locked, false);
  });

  it("normalizes username (trim + lowercase) for keys", () => {
    const t0 = 1_700_400_000_000;
    const ip = "198.51.100.77";
    for (let i = 0; i < 5; i++) {
      recordAdminLoginFailure({ username: "  Admin@X.Test ", clientIp: ip, now: t0 + i });
    }
    assert.equal(
      checkAdminLoginGuard({ username: "admin@x.test", clientIp: ip, now: t0 + 10 }).locked,
      true
    );
  });
});
