/**
 * BATCH-14 cross-zone city/province overlap detection (pure).
 * Run: node --test tests/shipping-zone-overlap.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { findZoneListOverlap, formatOverlapError } = await import("../lib/shippingZoneOverlap.ts");

type Z = {
  id: number;
  name: string;
  cities: string | null;
  provinces: string | null;
  active: number;
};

const lahore: Z = {
  id: 1,
  name: "Lahore",
  cities: "Lahore",
  provinces: null,
  active: 1,
};
const sindh: Z = {
  id: 2,
  name: "Sindh zone",
  cities: null,
  provinces: "Sindh",
  active: 1,
};
const rest: Z = {
  id: 3,
  name: "Rest of Pakistan",
  cities: null,
  provinces: null,
  active: 1,
};

describe("findZoneListOverlap", () => {
  it("rejects city already used by another active zone (case/whitespace)", () => {
    const c = findZoneListOverlap({
      cities: "  lahore ",
      provinces: null,
      otherZones: [lahore, rest],
    });
    assert.ok(c);
    assert.equal(c!.kind, "city");
    assert.equal(c!.otherZoneName, "Lahore");
    assert.match(formatOverlapError(c!), /Lahore/);
  });

  it("rejects province already used", () => {
    const c = findZoneListOverlap({
      cities: null,
      provinces: "SINDH",
      otherZones: [sindh, rest],
    });
    assert.ok(c);
    assert.equal(c!.kind, "province");
    assert.equal(c!.otherZoneId, 2);
  });

  it("self-edit is exempt", () => {
    const c = findZoneListOverlap({
      cities: "Lahore\nKasur",
      provinces: null,
      excludeZoneId: 1,
      otherZones: [lahore, rest],
    });
    assert.equal(c, null);
  });

  it("inactive zone does not block", () => {
    const off = { ...lahore, active: 0 };
    const c = findZoneListOverlap({
      cities: "Lahore",
      provinces: null,
      otherZones: [off, rest],
    });
    assert.equal(c, null);
  });

  it("default / empty lists are exempt", () => {
    assert.equal(
      findZoneListOverlap({ cities: null, provinces: null, otherZones: [lahore] }),
      null
    );
    assert.equal(
      findZoneListOverlap({ cities: "", provinces: "  \n ", otherZones: [lahore] }),
      null
    );
  });

  it("reactivation check: exclude self but still collide with other active", () => {
    const inactiveSelf = { ...lahore, id: 9, name: "Old Lahore", active: 0 };
    // Other active zone already holds Lahore
    const c = findZoneListOverlap({
      cities: "Lahore",
      provinces: null,
      excludeZoneId: 9,
      otherZones: [lahore, inactiveSelf, rest],
    });
    assert.ok(c);
    assert.equal(c!.otherZoneId, 1);
  });

  it("no conflict when city free", () => {
    assert.equal(
      findZoneListOverlap({
        cities: "Karachi",
        provinces: null,
        otherZones: [lahore, rest],
      }),
      null
    );
  });
});
