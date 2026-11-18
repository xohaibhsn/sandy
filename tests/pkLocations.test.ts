/**
 * BATCH-14 Pakistan location list sanity.
 * Run: node --test tests/pkLocations.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { PK_CITIES, PK_PROVINCES, isKnownPkProvince } = await import("../lib/pkLocations.ts");
const { PAKISTAN_PROVINCES } = await import("../lib/site.ts");
const { normaliseCity } = await import("../lib/shippingNormalise.ts");

describe("pkLocations", () => {
  it("provinces match checkout PAKISTAN_PROVINCES exactly", () => {
    assert.deepEqual([...PK_PROVINCES], [...PAKISTAN_PROVINCES]);
  });

  it("has no duplicate cities (case/whitespace-insensitive)", () => {
    const seen = new Set<string>();
    for (const c of PK_CITIES) {
      const k = normaliseCity(c.name);
      assert.ok(k, `empty city name`);
      assert.equal(seen.has(k), false, `duplicate city: ${c.name}`);
      seen.add(k);
    }
  });

  it("every city maps to a known province", () => {
    for (const c of PK_CITIES) {
      assert.equal(isKnownPkProvince(c.province), true, `${c.name} -> ${c.province}`);
    }
  });

  it("cities are alphabetical by name", () => {
    const names = PK_CITIES.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "en"));
    assert.deepEqual(names, sorted);
  });

  it("includes provincial capitals and major cities", () => {
    const keys = new Set(PK_CITIES.map((c) => normaliseCity(c.name)));
    for (const must of ["Lahore", "Karachi", "Islamabad", "Peshawar", "Quetta", "Gilgit", "Muzaffarabad"]) {
      assert.equal(keys.has(normaliseCity(must)), true, must);
    }
  });

  it("has a substantial city list (>= 80)", () => {
    assert.ok(PK_CITIES.length >= 80, `got ${PK_CITIES.length}`);
  });
});
