/**
 * Unit tests for isMasterLoginConfigured() — master env presence rules.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { isMasterLoginConfigured } = await import("../lib/adminAuth.ts");

const KEYS = ["ADMIN_PASSWORD", "ADMIN_PASSWORD_SHA256", "ADMIN_PASSWORD_HASH"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isMasterLoginConfigured", () => {
  it("false when none set", () => {
    assert.equal(isMasterLoginConfigured(), false);
  });

  it("true when ADMIN_PASSWORD plain non-empty", () => {
    process.env.ADMIN_PASSWORD = "plain-master-value";
    assert.equal(isMasterLoginConfigured(), true);
  });

  it("true when ADMIN_PASSWORD_SHA256 non-empty", () => {
    process.env.ADMIN_PASSWORD_SHA256 = "a".repeat(64);
    assert.equal(isMasterLoginConfigured(), true);
  });

  it('true when ADMIN_PASSWORD_HASH starts with "$2"', () => {
    process.env.ADMIN_PASSWORD_HASH = "$2a$12$abcdefghijklmnopqrstuv";
    assert.equal(isMasterLoginConfigured(), true);
  });

  it('false when ADMIN_PASSWORD_HASH set but does not start with "$2"', () => {
    process.env.ADMIN_PASSWORD_HASH = "not-a-bcrypt-hash";
    assert.equal(isMasterLoginConfigured(), false);
  });

  it("false when all three are empty strings", () => {
    process.env.ADMIN_PASSWORD = "";
    process.env.ADMIN_PASSWORD_SHA256 = "";
    process.env.ADMIN_PASSWORD_HASH = "";
    assert.equal(isMasterLoginConfigured(), false);
  });
});
