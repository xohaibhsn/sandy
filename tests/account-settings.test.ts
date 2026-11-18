/**
 * Customer-accounts settings (BATCH-09) — unit test, no real database.
 *
 * Covers parseAccountSettingsMap (defaults OFF), validateAccountSetting (0/1 only),
 * key helpers, and the loadAccountSettings TTL cache (with a fake pool installed on globalThis._mysqlPool).
 *
 * Run: node --test tests/account-settings.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

type FakeState = { rows: Array<{ content_key: string; content_value: string | null }>; calls: number; fail: boolean };
const state: FakeState = { rows: [], calls: 0, fail: false };

// lib/db.ts reads globalThis._mysqlPool lazily, so a fake pool is enough for the loader.
(globalThis as unknown as { _mysqlPool: unknown })._mysqlPool = {
  async query(sql: string, params: unknown[]) {
    state.calls += 1;
    assert.match(sql, /FROM site_content/);
    assert.deepEqual(params, ["accounts_enabled"], "only the accounts_enabled key is requested");
    if (state.fail) throw new Error("db down");
    return [state.rows];
  },
};

const {
  ACCOUNT_SETTINGS_DEFAULTS,
  ACCOUNT_SETTINGS_KEYS,
  isAccountSettingsContentKey,
  loadAccountSettings,
  parseAccountSettingsMap,
  resetAccountSettingsCache,
  validateAccountSetting,
} = await import("../lib/accountSettings.ts");

describe("parseAccountSettingsMap", () => {
  it("defaults to OFF for an empty map", () => {
    assert.deepEqual(parseAccountSettingsMap({}), { accounts_enabled: false });
    assert.equal(ACCOUNT_SETTINGS_DEFAULTS.accounts_enabled, false);
  });

  it("reads 1 as on and 0 as off (whitespace tolerated)", () => {
    assert.equal(parseAccountSettingsMap({ accounts_enabled: "1" }).accounts_enabled, true);
    assert.equal(parseAccountSettingsMap({ accounts_enabled: " 1 " }).accounts_enabled, true);
    assert.equal(parseAccountSettingsMap({ accounts_enabled: "0" }).accounts_enabled, false);
  });

  it("falls back to OFF for null / undefined / empty / garbage", () => {
    for (const v of [null, undefined, "", "   ", "true", "yes", "on", "2", "-1", "1.0", "enabled"]) {
      assert.equal(parseAccountSettingsMap({ accounts_enabled: v }).accounts_enabled, false, `value ${JSON.stringify(v)}`);
    }
  });

  it("ignores unrelated keys", () => {
    assert.deepEqual(parseAccountSettingsMap({ cod_protection_enabled: "1", other: "1" }), { accounts_enabled: false });
  });
});

describe("validateAccountSetting", () => {
  it("accepts 0 and 1 (string or number), returning the canonical string", () => {
    assert.deepEqual(validateAccountSetting("accounts_enabled", "1"), { ok: true, value: "1" });
    assert.deepEqual(validateAccountSetting("accounts_enabled", "0"), { ok: true, value: "0" });
    assert.deepEqual(validateAccountSetting("accounts_enabled", 1), { ok: true, value: "1" });
    assert.deepEqual(validateAccountSetting("accounts_enabled", 0), { ok: true, value: "0" });
    assert.deepEqual(validateAccountSetting("accounts_enabled", " 1 "), { ok: true, value: "1" });
  });

  it("rejects everything else", () => {
    for (const v of ["", "2", "-1", "true", "false", "yes", "on", null, undefined, {}, [], 1.5, "1; DROP TABLE x"]) {
      const r = validateAccountSetting("accounts_enabled", v);
      assert.equal(r.ok, false, `value ${JSON.stringify(v)} must be rejected`);
    }
    assert.deepEqual(validateAccountSetting("accounts_enabled", "9"), { ok: false, error: "Invalid flag (use 0 or 1)" });
  });

  it("rejects unknown keys", () => {
    assert.deepEqual(validateAccountSetting("not_a_key", "1"), { ok: false, error: "Unknown setting" });
    assert.deepEqual(validateAccountSetting("cod_protection_enabled", "1"), { ok: false, error: "Unknown setting" });
  });
});

describe("isAccountSettingsContentKey", () => {
  it("recognises exactly the accounts keys", () => {
    assert.deepEqual([...ACCOUNT_SETTINGS_KEYS], ["accounts_enabled"]);
    assert.equal(isAccountSettingsContentKey("accounts_enabled"), true);
    for (const k of ["cod_protection_enabled", "", null, undefined, 1, "accounts_enabled2", "ACCOUNTS_ENABLED"]) {
      assert.equal(isAccountSettingsContentKey(k), false, `key ${JSON.stringify(k)}`);
    }
  });
});

describe("loadAccountSettings (cache)", () => {
  beforeEach(() => {
    state.rows = [];
    state.calls = 0;
    state.fail = false;
    resetAccountSettingsCache();
  });

  it("defaults OFF when the key is absent", async () => {
    assert.deepEqual(await loadAccountSettings(), { accounts_enabled: false });
    assert.equal(state.calls, 1);
  });

  it("reads the flag from site_content", async () => {
    state.rows = [{ content_key: "accounts_enabled", content_value: "1" }];
    assert.deepEqual(await loadAccountSettings(), { accounts_enabled: true });
  });

  it("serves the cached value inside the TTL, and picks up changes after a reset", async () => {
    state.rows = [{ content_key: "accounts_enabled", content_value: "1" }];
    assert.equal((await loadAccountSettings()).accounts_enabled, true);
    assert.equal(state.calls, 1);

    state.rows = [{ content_key: "accounts_enabled", content_value: "0" }];
    assert.equal((await loadAccountSettings()).accounts_enabled, true, "stale value inside TTL");
    assert.equal(state.calls, 1, "no second query inside TTL");

    resetAccountSettingsCache();
    assert.equal((await loadAccountSettings()).accounts_enabled, false, "reset drops the cache");
    assert.equal(state.calls, 2);
  });

  it("falls back to OFF on a database error (and caches that default)", async () => {
    state.fail = true;
    assert.deepEqual(await loadAccountSettings(), { accounts_enabled: false });
    assert.equal(state.calls, 1);
    state.fail = false;
    state.rows = [{ content_key: "accounts_enabled", content_value: "1" }];
    assert.equal((await loadAccountSettings()).accounts_enabled, false, "default cached for the TTL");
    resetAccountSettingsCache();
    assert.equal((await loadAccountSettings()).accounts_enabled, true);
  });

  it("treats a NULL / garbage stored value as OFF", async () => {
    state.rows = [{ content_key: "accounts_enabled", content_value: null }];
    assert.equal((await loadAccountSettings()).accounts_enabled, false);
    resetAccountSettingsCache();
    state.rows = [{ content_key: "accounts_enabled", content_value: "maybe" }];
    assert.equal((await loadAccountSettings()).accounts_enabled, false);
  });
});
