/**
 * BATCH-17 delivery-ops core libraries — pure matrix + mocked schema probes (no database).
 * Run: node --test tests/shipping-delivery-ops.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const shipping = await import("../lib/shipping.ts");
const {
  matchZone,
  matchZoneWithAreas,
  formatSameDayEstimate,
  quoteShippingFromLines,
  enrichZonesWithDeliveryOps,
  canEnableShipping,
  canEnableRestrict,
  hasListedCitiesOrProvinces,
  AREA_NOT_SERVED_MESSAGE,
  AREA_REQUIRED_MESSAGE,
} = shipping;
const areasLib = await import("../lib/shippingAreas.ts");
const {
  resolveAreaPath,
  findAreaById,
  getAncestorChain,
  resolveZoneIdFromArea,
  wouldCreateParentCycle,
  findDuplicateArea,
  normalisedAreaKey,
} = areasLib;
const status = await import("../lib/shippingStatus.ts");
const {
  ORDER_STATUSES,
  isPickupOrder,
  assertStatusTransition,
  ownRiderTrackingLabel,
  riderFirstName,
  readyForPickupLabel,
  deliveredLabel,
} = status;
const schema = await import("../lib/shippingSchema.ts");
const settings = await import("../lib/shippingSettings.ts");

type Zone = Parameters<typeof matchZone>[0][number];
type Area = Parameters<typeof resolveAreaPath>[0][number];

function zone(over: Partial<Zone> & { id: number; name: string }): Zone {
  return {
    cities: null,
    provinces: null,
    is_default: false,
    rate: 100,
    free_min: null,
    estimate_text: null,
    active: true,
    sort_order: over.id,
    ...over,
  };
}

function area(over: Partial<Area> & { id: number; city: string; name: string }): Area {
  return { parent_id: null, zone_id: null, active: true, sort_order: over.id, ...over };
}

const zCity = zone({ id: 1, name: "CityZone", cities: "Metro City", rate: 200 });
const zProv = zone({ id: 2, name: "ProvZone", provinces: "Alpha Province", rate: 300 });
const zDefault = zone({ id: 3, name: "Default", is_default: true, rate: 500 });
const zArea = zone({ id: 4, name: "AreaZone", rate: 150 });
const zParent = zone({ id: 5, name: "ParentZone", rate: 175 });
const zones = [zCity, zProv, zDefault, zArea, zParent];

// Tree: 10 (Parent, zone 5) > 11 (Child, no zone) > 12 (Grandchild, zone 4); 20 sibling root w/o zone.
const areas: Area[] = [
  area({ id: 10, city: "Metro City", name: "Parent", zone_id: 5 }),
  area({ id: 11, city: "Metro City", name: "Child", parent_id: 10 }),
  area({ id: 12, city: "Metro City", name: "Grandchild", parent_id: 11, zone_id: 4 }),
  area({ id: 20, city: "Metro City", name: "Loose" }),
  area({ id: 30, city: "Other Town", name: "Elsewhere", zone_id: 4 }),
];

const shippable = [{ price: 1000, quantity: 1, shippable: true }];

describe("matchZoneWithAreas precedence", () => {
  const base = { city: "Metro City", province: "Alpha Province" };

  it("1. area's own active zone wins over city / province / default", () => {
    const r = matchZoneWithAreas(zones, areas, { ...base, areaId: 12 });
    assert.equal(r.zone?.id, 4);
    assert.equal(r.refused, false);
    assert.equal(r.areaSnapshot, "Parent > Child > Grandchild");
  });

  it("2. area without zone inherits the nearest ancestor zone", () => {
    const r = matchZoneWithAreas(zones, areas, { ...base, areaId: 11 });
    assert.equal(r.zone?.id, 5);
    assert.equal(r.areaSnapshot, "Parent > Child");
  });

  it("3. area with no zone in its chain falls back to the city zone", () => {
    const r = matchZoneWithAreas(zones, areas, { ...base, areaId: 20 });
    assert.equal(r.zone?.id, 1);
    assert.equal(r.areaSnapshot, "Loose");
  });

  it("4. no area: city zone; unknown city: province zone; neither: default", () => {
    assert.equal(matchZoneWithAreas(zones, areas, base).zone?.id, 1);
    assert.equal(
      matchZoneWithAreas(zones, areas, { city: "Nowhere", province: "Alpha Province" }).zone?.id,
      2
    );
    assert.equal(
      matchZoneWithAreas(zones, areas, { city: "Nowhere", province: "Beta" }).zone?.id,
      3
    );
  });

  it("5. restrict skips the default and refuses", () => {
    const r = matchZoneWithAreas(zones, areas, {
      city: "Nowhere",
      province: "Beta",
      restrictToZones: true,
    });
    assert.equal(r.zone, null);
    assert.equal(r.refused, true);
  });

  it("restrict still allows city / province / area matches", () => {
    assert.equal(
      matchZoneWithAreas(zones, areas, { ...base, areaId: 12, restrictToZones: true }).zone?.id,
      4
    );
    assert.equal(
      matchZoneWithAreas(zones, areas, { ...base, restrictToZones: true }).zone?.id,
      1
    );
    assert.equal(
      matchZoneWithAreas(zones, areas, {
        city: "Nowhere",
        province: "Alpha Province",
        restrictToZones: true,
      }).zone?.id,
      2
    );
  });

  it("without restrict and no zones at all: zone null, not refused", () => {
    const r = matchZoneWithAreas([], areas, base);
    assert.equal(r.zone, null);
    assert.equal(r.refused, false);
  });

  it("area from another city is ignored (never trusted alone)", () => {
    const r = matchZoneWithAreas(zones, areas, {
      city: "Metro City",
      province: "Beta",
      areaId: 30,
    });
    assert.equal(r.zone?.id, 1); // city zone, NOT area 30's zone 4
    assert.equal(r.areaSnapshot, null);
  });

  it("city comparison is normalised (case / punctuation / whitespace)", () => {
    const r = matchZoneWithAreas(zones, areas, {
      city: "  METRO,  city!! ",
      province: "x",
      areaId: 12,
    });
    assert.equal(r.zone?.id, 4);
  });

  it("inactive area is skipped (falls to city zone) and has no snapshot", () => {
    const off = areas.map((a) => (a.id === 12 ? { ...a, active: false } : a));
    const r = matchZoneWithAreas(zones, off, { ...base, areaId: 12 });
    assert.equal(r.zone?.id, 1);
    assert.equal(r.areaSnapshot, null);
  });

  it("inactive ancestor's zone_id is skipped but the walk continues", () => {
    const chain: Area[] = [
      area({ id: 1, city: "Metro City", name: "Root", zone_id: 5 }),
      area({ id: 2, city: "Metro City", name: "Mid", parent_id: 1, zone_id: 4, active: false }),
      area({ id: 3, city: "Metro City", name: "Leaf", parent_id: 2 }),
    ];
    assert.equal(matchZoneWithAreas(zones, chain, { ...base, areaId: 3 }).zone?.id, 5);
  });

  it("area pinned to an inactive zone falls through to the next ancestor / city", () => {
    const zs = zones.map((z) => (z.id === 4 ? { ...z, active: false } : z));
    assert.equal(matchZoneWithAreas(zs, areas, { ...base, areaId: 12 }).zone?.id, 5);
    const zs2 = zs.map((z) => (z.id === 5 ? { ...z, active: false } : z));
    assert.equal(matchZoneWithAreas(zs2, areas, { ...base, areaId: 12 }).zone?.id, 1);
  });

  it("inactive city / default zones are ignored", () => {
    const zs = zones.map((z) => (z.id === 1 || z.id === 3 ? { ...z, active: false } : z));
    assert.equal(matchZoneWithAreas(zs, areas, { city: "Metro City", province: "Beta" }).zone, null);
  });

  it("zone listing is normalised via shippingNormalise (multi-line list, punctuation)", () => {
    const z = zone({ id: 9, name: "Multi", cities: "First City\nMETRO   City!; Third" });
    assert.equal(matchZoneWithAreas([z], [], { city: "metro city", province: "" }).zone?.id, 9);
  });

  it("matchZone (unchanged) ignores areas entirely and still falls to default", () => {
    assert.equal(matchZone(zones, "Metro City", "Beta")?.id, 1);
    assert.equal(matchZone(zones, "Nowhere", "Beta")?.id, 3);
    assert.equal(matchZone([zCity, zProv], "Nowhere", "Beta"), null);
  });
});

describe("shippingAreas pure helpers", () => {
  it("resolveAreaPath builds 'Parent > Child' snapshots, null for unknown", () => {
    assert.equal(resolveAreaPath(areas, 12), "Parent > Child > Grandchild");
    assert.equal(resolveAreaPath(areas, 10), "Parent");
    assert.equal(resolveAreaPath(areas, "11"), "Parent > Child");
    assert.equal(resolveAreaPath(areas, 999), null);
    assert.equal(resolveAreaPath(areas, null), null);
  });

  it("resolveAreaPath truncates to the 160-char column", () => {
    const long: Area[] = [
      area({ id: 1, city: "c", name: "a".repeat(100) }),
      area({ id: 2, city: "c", name: "b".repeat(100), parent_id: 1 }),
    ];
    assert.equal(resolveAreaPath(long, 2)?.length, 160);
  });

  it("findAreaById / getAncestorChain", () => {
    assert.equal(findAreaById(areas, 20)?.name, "Loose");
    assert.equal(findAreaById(areas, "x"), null);
    assert.deepEqual(
      getAncestorChain(areas, 12).map((a: Area) => a.id),
      [12, 11, 10]
    );
    assert.deepEqual(getAncestorChain(areas, 404), []);
  });

  it("getAncestorChain survives a corrupt parent loop", () => {
    const loop: Area[] = [
      area({ id: 1, city: "c", name: "A", parent_id: 2 }),
      area({ id: 2, city: "c", name: "B", parent_id: 1 }),
    ];
    assert.deepEqual(
      getAncestorChain(loop, 1).map((a: Area) => a.id),
      [1, 2]
    );
  });

  it("resolveZoneIdFromArea honours the active-zone set", () => {
    assert.equal(resolveZoneIdFromArea(areas, 12), 4);
    assert.equal(resolveZoneIdFromArea(areas, 11), 5);
    assert.equal(resolveZoneIdFromArea(areas, 20), null);
    assert.equal(resolveZoneIdFromArea(areas, 12, new Set([5])), 5);
    assert.equal(resolveZoneIdFromArea(areas, 12, new Set([99])), null);
  });

  it("wouldCreateParentCycle", () => {
    assert.equal(wouldCreateParentCycle(areas, 10, 10), true); // self
    assert.equal(wouldCreateParentCycle(areas, 10, 12), true); // descendant
    assert.equal(wouldCreateParentCycle(areas, 10, 11), true);
    assert.equal(wouldCreateParentCycle(areas, 12, 10), false); // re-parent upward is fine
    assert.equal(wouldCreateParentCycle(areas, 20, 12), false);
    assert.equal(wouldCreateParentCycle(areas, 10, null), false);
    assert.equal(wouldCreateParentCycle(areas, null, 12), false); // new row cannot cycle
  });

  it("normalised duplicate check (city + parent + name)", () => {
    assert.equal(
      findDuplicateArea(areas, { city: "METRO city", parent_id: 10, name: " child! " })?.id,
      11
    );
    // different parent => not a duplicate
    assert.equal(findDuplicateArea(areas, { city: "Metro City", parent_id: null, name: "Child" }), null);
    // editing a row keeps its own name
    assert.equal(findDuplicateArea(areas, { city: "Metro City", parent_id: 10, name: "Child" }, 11), null);
    // empty / punctuation-only names never match
    assert.equal(findDuplicateArea(areas, { city: "Metro City", name: "!!" }), null);
    assert.equal(normalisedAreaKey("A  B", "5", "X-Y"), "a b|5|xy");
    assert.equal(normalisedAreaKey("a", null, "x"), "a|0|x");
  });
});

describe("formatSameDayEstimate", () => {
  it("cutoff set => same-day text (TIME re-formatted as HH:MM)", () => {
    assert.equal(formatSameDayEstimate("16:00:00", "1-2 days"), "Same-day delivery for orders before 16:00");
    assert.equal(formatSameDayEstimate("09:05", null), "Same-day delivery for orders before 09:05");
    assert.equal(formatSameDayEstimate("9:30:15", null), "Same-day delivery for orders before 09:30");
    assert.equal(formatSameDayEstimate("00:00:00", null), "Same-day delivery for orders before 00:00");
  });

  it("no / invalid cutoff => estimate text (trimmed) or null", () => {
    assert.equal(formatSameDayEstimate(null, "  1-2 days "), "1-2 days");
    assert.equal(formatSameDayEstimate(null, null), null);
    assert.equal(formatSameDayEstimate("", "x"), "x");
    assert.equal(formatSameDayEstimate("25:00:00", "x"), "x");
    assert.equal(formatSameDayEstimate("garbage", null), null);
    assert.equal(formatSameDayEstimate(undefined, "   "), null);
  });
});

describe("quoteShippingFromLines — delivery ops", () => {
  const common = { lines: shippable, discountAmount: 0, city: "Metro City", province: "Beta" };

  it("flags off: result is identical to the legacy shape (no new keys)", () => {
    const q = quoteShippingFromLines({ zones, ...common });
    assert.deepEqual(q, {
      amount: 200,
      zoneId: 1,
      zoneName: "CityZone",
      estimateText: null,
      hasShippableItems: true,
      unavailable: false,
    });
    const none = quoteShippingFromLines({ zones: [], ...common });
    assert.deepEqual(none, {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: true,
      unavailable: true,
    });
  });

  it("pickup (enabled) => 0, no zone, deliverable, even with shippable items and no zones", () => {
    for (const zs of [zones, []]) {
      const q = quoteShippingFromLines({
        zones: zs,
        ...common,
        fulfilment: "pickup",
        pickupEnabled: true,
      });
      assert.equal(q.amount, 0);
      assert.equal(q.zoneId, null);
      assert.equal(q.unavailable, false);
      assert.equal(q.deliverable, true);
      assert.equal(q.fulfilment, "pickup");
      assert.equal(q.hasShippableItems, true);
    }
  });

  it("pickup requested but pickup disabled => ordinary delivery quote", () => {
    const q = quoteShippingFromLines({ zones, ...common, fulfilment: "pickup", pickupEnabled: false });
    assert.equal(q.amount, 200);
    assert.equal(q.fulfilment, undefined);
  });

  it("pickup enabled but delivery chosen => delivery quote flagged fulfilment=delivery", () => {
    const q = quoteShippingFromLines({ zones, ...common, fulfilment: "delivery", pickupEnabled: true });
    assert.equal(q.amount, 200);
    assert.equal(q.fulfilment, "delivery");
    assert.equal(q.deliverable, true);
  });

  it("areas path: area zone + snapshot", () => {
    const q = quoteShippingFromLines({ zones, areas, areaId: 12, ...common });
    assert.equal(q.amount, 150);
    assert.equal(q.zoneId, 4);
    assert.equal(q.shippingAreaSnapshot, "Parent > Child > Grandchild");
    assert.equal(q.deliverable, true);
    assert.equal(q.deliveryMethod, "courier");
  });

  it("areas path with no area id uses city-level matching ('Other area in city')", () => {
    const q = quoteShippingFromLines({ zones, areas, ...common });
    assert.equal(q.zoneId, 1);
    assert.equal(q.shippingAreaSnapshot, null);
  });

  it("requireAreaSelection (orders): city with active areas needs a valid area OR other_area = true", () => {
    const req = { zones, areas, requireAreaSelection: true, ...common };
    // nothing selected => refused as "area required" (not "not served")
    const none = quoteShippingFromLines(req);
    assert.equal(none.deliverable, false);
    assert.equal(none.areaRequired, true);
    assert.equal(none.refuseReason, AREA_REQUIRED_MESSAGE);
    assert.notEqual(none.refuseReason, AREA_NOT_SERVED_MESSAGE);
    assert.equal(none.amount, 0);
    assert.equal(none.unavailable, false);
    // unknown / other-city / garbage ids count as "nothing selected"
    for (const areaId of [999, 30, "abc", 0, null]) {
      assert.equal(quoteShippingFromLines({ ...req, areaId }).areaRequired, true, String(areaId));
    }
    // explicit other area => city-level match
    const other = quoteShippingFromLines({ ...req, otherArea: true });
    assert.equal(other.deliverable, true);
    assert.equal(other.areaRequired, undefined);
    assert.equal(other.zoneId, 1);
    assert.equal(other.shippingAreaSnapshot, null);
    // valid area
    const sel = quoteShippingFromLines({ ...req, areaId: 12 });
    assert.equal(sel.deliverable, true);
    assert.equal(sel.zoneId, 4);
    // another city without active areas: no requirement
    const noAreas = quoteShippingFromLines({ ...req, city: "Nowhere" });
    assert.equal(noAreas.deliverable, true);
    // nothing to ship: no requirement
    const digital = quoteShippingFromLines({
      ...req,
      lines: [{ price: 500, quantity: 1, shippable: false }],
    });
    assert.equal(digital.deliverable, true);
    // advisory callers (flag omitted) are unchanged
    assert.equal(quoteShippingFromLines({ zones, areas, ...common }).deliverable, true);
  });

  it("requireAreaSelection ignores INACTIVE areas when deciding whether the city has areas", () => {
    const inactiveOnly = [area({ id: 40, city: "Metro City", name: "Gone", active: false })];
    const q = quoteShippingFromLines({ zones, areas: inactiveOnly, requireAreaSelection: true, ...common });
    assert.equal(q.deliverable, true);
    assert.equal(areasLib.cityHasActiveAreas(inactiveOnly, "metro city"), false);
    assert.equal(areasLib.cityHasActiveAreas(areas, " METRO city "), true);
    assert.equal(areasLib.cityHasActiveAreas(areas, ""), false);
  });

  it("restrict refusal: amount 0, deliverable false, not unavailable, generic reason", () => {
    const q = quoteShippingFromLines({
      zones,
      areas,
      restrictToZones: true,
      ...common,
      city: "Nowhere",
    });
    assert.equal(q.amount, 0);
    assert.equal(q.unavailable, false);
    assert.equal(q.deliverable, false);
    assert.equal(q.refuseReason, "We don't deliver to this area yet.");
    assert.equal(q.refuseReason, AREA_NOT_SERVED_MESSAGE);
    assert.equal(q.zoneId, null);
  });

  it("restrict with areas omitted still refuses (matcher runs with an empty tree)", () => {
    const q = quoteShippingFromLines({ zones, restrictToZones: true, ...common, city: "Nowhere" });
    assert.equal(q.deliverable, false);
  });

  it("restrict never refuses an order with nothing to ship", () => {
    const q = quoteShippingFromLines({
      zones,
      areas,
      restrictToZones: true,
      lines: [{ price: 500, quantity: 1, shippable: false }],
      discountAmount: 0,
      city: "Nowhere",
      province: "Beta",
    });
    assert.equal(q.deliverable, true);
    assert.equal(q.hasShippableItems, false);
    assert.equal(q.amount, 0);
  });

  it("own-rider zone: same-day estimate text from cutoff; falls back to estimate_text", () => {
    const rider = zone({
      id: 7,
      name: "Rider",
      cities: "Metro City",
      rate: 120,
      estimate_text: "1-2 days",
      delivery_method: "own_rider",
      same_day_cutoff: "15:30:00",
    });
    const q = quoteShippingFromLines({ zones: [rider], ...common });
    assert.equal(q.estimateText, "Same-day delivery for orders before 15:30");
    assert.equal(q.deliveryMethod, "own_rider");
    const q2 = quoteShippingFromLines({
      zones: [{ ...rider, same_day_cutoff: null }],
      ...common,
    });
    assert.equal(q2.estimateText, "1-2 days");
  });

  it("free_min / discount base logic unchanged on the areas path", () => {
    const z = zone({ id: 8, name: "Free", cities: "Metro City", rate: 200, free_min: 1000 });
    const eq = quoteShippingFromLines({ zones: [z], areas: [], ...common });
    assert.equal(eq.amount, 0);
    const disc = quoteShippingFromLines({ zones: [z], areas: [], ...common, discountAmount: 1 });
    assert.equal(disc.amount, 200);
  });

  it("enrichZonesWithDeliveryOps defaults to courier / null", () => {
    const out = enrichZonesWithDeliveryOps(
      [zCity, zProv],
      new Map([[1, { delivery_method: "own_rider" as const, same_day_cutoff: "10:00:00" }]])
    );
    assert.equal(out[0].delivery_method, "own_rider");
    assert.equal(out[0].same_day_cutoff, "10:00:00");
    assert.equal(out[1].delivery_method, "courier");
    assert.equal(out[1].same_day_cutoff, null);
    assert.equal((zCity as Zone).delivery_method, undefined); // input not mutated
  });
});

describe("status transitions", () => {
  it("ORDER_STATUSES includes ready_for_pickup; existing statuses intact", () => {
    for (const s of ["pending", "confirmed", "dispatched", "delivered", "cancelled", "ready_for_pickup"]) {
      assert.ok((ORDER_STATUSES as readonly string[]).includes(s), s);
    }
  });

  it("isPickupOrder", () => {
    assert.equal(isPickupOrder("pickup"), true);
    assert.equal(isPickupOrder(" Pickup "), true);
    assert.equal(isPickupOrder("delivery"), false);
    assert.equal(isPickupOrder(null), false);
    assert.equal(isPickupOrder(undefined), false);
  });

  it("pickup path pending -> confirmed -> ready_for_pickup -> delivered, cancel allowed", () => {
    const steps: Array<[string, string]> = [
      ["pending", "confirmed"],
      ["confirmed", "ready_for_pickup"],
      ["ready_for_pickup", "delivered"],
      ["pending", "cancelled"],
      ["ready_for_pickup", "cancelled"],
    ];
    for (const [from, to] of steps) {
      const r = assertStatusTransition({ fulfilment: "pickup", from, to });
      assert.deepEqual(r, { ok: true, nextStatus: to }, `${from}->${to}`);
    }
  });

  it("pickup refuses dispatched (409) and RTO (409)", () => {
    const d = assertStatusTransition({ fulfilment: "pickup", from: "confirmed", to: "dispatched" });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.status, 409);
      assert.equal(d.code, "PICKUP_NO_DISPATCH");
    }
    const d2 = assertStatusTransition({
      fulfilment: "pickup",
      from: "confirmed",
      to: "confirmed",
      action: "dispatch",
    });
    assert.equal(d2.ok, false);
    const r = assertStatusTransition({
      fulfilment: "pickup",
      from: "ready_for_pickup",
      to: "cancelled",
      action: "rto",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409);
      assert.equal(r.code, "PICKUP_NO_RTO");
    }
  });

  it("delivery refuses ready_for_pickup (409); NULL fulfilment counts as delivery", () => {
    for (const f of ["delivery", null, undefined, ""]) {
      const r = assertStatusTransition({ fulfilment: f, from: "confirmed", to: "ready_for_pickup" });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.status, 409);
        assert.equal(r.code, "DELIVERY_NO_READY_FOR_PICKUP");
      }
    }
  });

  it("delivery keeps dispatch / deliver; RTO only from dispatched", () => {
    assert.equal(assertStatusTransition({ fulfilment: null, from: "confirmed", to: "dispatched" }).ok, true);
    assert.equal(assertStatusTransition({ fulfilment: null, from: "dispatched", to: "delivered" }).ok, true);
    assert.equal(
      assertStatusTransition({ fulfilment: null, from: "dispatched", to: "cancelled", action: "rto" }).ok,
      true
    );
    const bad = assertStatusTransition({
      fulfilment: null,
      from: "confirmed",
      to: "cancelled",
      action: "rto",
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "RTO_REQUIRES_DISPATCHED");
  });

  it("unknown target status => 400", () => {
    const r = assertStatusTransition({ fulfilment: null, from: "pending", to: "shipped" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("public labels: rider first name only, never a phone", () => {
    assert.equal(riderFirstName("  Ali Raza Khan "), "Ali");
    assert.equal(riderFirstName(""), "");
    assert.equal(riderFirstName(null), "");
    assert.equal(ownRiderTrackingLabel("Ali Raza"), "Out for delivery with our rider (Ali)");
    assert.equal(ownRiderTrackingLabel(""), "Out for delivery with our rider");
    assert.ok(!ownRiderTrackingLabel("Ali Raza").includes("Raza"));
    assert.equal(readyForPickupLabel("Main Store"), "Ready for pickup at Main Store");
    assert.equal(readyForPickupLabel(null), "Ready for pickup");
    assert.equal(deliveredLabel("pickup"), "Picked up");
    assert.equal(deliveredLabel(null), "Delivered");
  });
});

describe("enable gates", () => {
  it("canEnableShipping: exactly one default, or restrict + >=1 active zone", () => {
    assert.equal(canEnableShipping({ activeDefaultZones: 1, restrictOn: false, activeZones: 1 }), true);
    assert.equal(canEnableShipping({ activeDefaultZones: 0, restrictOn: false, activeZones: 3 }), false);
    assert.equal(canEnableShipping({ activeDefaultZones: 2, restrictOn: false, activeZones: 2 }), false);
    assert.equal(canEnableShipping({ activeDefaultZones: 0, restrictOn: true, activeZones: 1 }), true);
    assert.equal(canEnableShipping({ activeDefaultZones: 0, restrictOn: true, activeZones: 0 }), false);
    assert.equal(canEnableShipping({ activeDefaultZones: 1, restrictOn: true, activeZones: 0 }), true);
  });

  it("canEnableRestrict: areas on OR listed cities/provinces", () => {
    assert.equal(canEnableRestrict({ areasEnabled: true, hasListedCitiesOrProvinces: false }), true);
    assert.equal(canEnableRestrict({ areasEnabled: false, hasListedCitiesOrProvinces: true }), true);
    assert.equal(canEnableRestrict({ areasEnabled: false, hasListedCitiesOrProvinces: false }), false);
  });

  it("hasListedCitiesOrProvinces counts only active zones with non-empty normalised lists", () => {
    assert.equal(hasListedCitiesOrProvinces([zDefault]), false);
    assert.equal(hasListedCitiesOrProvinces([zCity]), true);
    assert.equal(hasListedCitiesOrProvinces([{ ...zCity, active: false }]), false);
    assert.equal(hasListedCitiesOrProvinces([zone({ id: 1, name: "x", cities: " ,;! " })]), false);
    assert.equal(hasListedCitiesOrProvinces([zProv]), true);
  });
});

describe("delivery-ops settings", () => {
  it("defaults are OFF and parse 0/1 only", () => {
    const d = settings.parseShippingSettingsMap({});
    assert.equal(d.shipping_areas_enabled, false);
    assert.equal(d.shipping_restrict_to_zones, false);
    assert.equal(d.pickup_enabled, false);
    assert.equal(d.shipping_enabled, false);
    const on = settings.parseShippingSettingsMap({
      shipping_areas_enabled: "1",
      shipping_restrict_to_zones: "1",
      pickup_enabled: "1",
    });
    assert.equal(on.shipping_areas_enabled, true);
    assert.equal(on.shipping_restrict_to_zones, true);
    assert.equal(on.pickup_enabled, true);
    const junk = settings.parseShippingSettingsMap({ pickup_enabled: "yes", shipping_areas_enabled: "2" });
    assert.equal(junk.pickup_enabled, false);
    assert.equal(junk.shipping_areas_enabled, false);
  });

  it("keys registered and validated as 0/1", () => {
    for (const k of ["shipping_areas_enabled", "shipping_restrict_to_zones", "pickup_enabled"]) {
      assert.ok((settings.SHIPPING_SETTINGS_KEYS as readonly string[]).includes(k), k);
      assert.ok(settings.isShippingSettingsContentKey(k));
      assert.deepEqual(settings.validateShippingSetting(k, "1"), { ok: true, value: "1" });
      assert.deepEqual(settings.validateShippingSetting(k, " 0 "), { ok: true, value: "0" });
      assert.equal(settings.validateShippingSetting(k, "true").ok, false);
      assert.equal(settings.validateShippingSetting(k, "").ok, false);
      assert.equal(settings.validateShippingSetting(k, null).ok, false);
    }
    assert.equal(settings.validateShippingSetting("nope", "1").ok, false);
  });
});

describe("schema probes (mocked INFORMATION_SCHEMA)", () => {
  beforeEach(() => schema.resetShippingSchemaCache());

  function makeDb(present: { tables: string[]; columns: Record<string, string[]> }) {
    const calls: string[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        calls.push(sql);
        if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
          const wanted = (params as string[]).filter((t) => present.tables.includes(t));
          return [wanted.map((TABLE_NAME) => ({ TABLE_NAME })), []];
        }
        const [table, ...cols] = params as string[];
        const have = present.columns[table] ?? [];
        return [cols.filter((c) => have.includes(c)).map((COLUMN_NAME) => ({ COLUMN_NAME })), []];
      },
    };
    return { db: db as never, calls };
  }

  const ops0009 = {
    tables: ["shipping_zones", "couriers"],
    columns: {
      orders: [...schema.SHIPPING_ORDER_COLUMNS],
      products: ["requires_shipping"],
    } as Record<string, string[]>,
  };

  it("0010 columns are NOT part of the 0009 probes", () => {
    for (const c of schema.DELIVERY_OPS_ORDER_COLUMNS) {
      assert.ok(!(schema.SHIPPING_ORDER_COLUMNS as readonly string[]).includes(c), c);
    }
    for (const t of schema.DELIVERY_OPS_TABLES) {
      assert.ok(!(schema.SHIPPING_TABLES as readonly string[]).includes(t), t);
    }
    assert.deepEqual([...schema.DELIVERY_OPS_TABLES], ["shipping_areas", "riders", "pickup_points"]);
    assert.deepEqual([...schema.DELIVERY_OPS_ORDER_COLUMNS], [
      "fulfilment",
      "shipping_area",
      "rider_id",
      "pickup_point_id",
      "pickup_point_name",
    ]);
    assert.deepEqual([...schema.DELIVERY_OPS_ZONE_COLUMNS], ["delivery_method", "same_day_cutoff"]);
  });

  it("0009-only database: hasShippingSchema true, hasDeliveryOpsSchema false", async () => {
    const { db } = makeDb(ops0009);
    assert.equal(await schema.hasShippingSchema(db), true);
    assert.equal(await schema.hasDeliveryOpsTables(db), false);
    assert.equal(await schema.hasDeliveryOpsOrderColumns(db), false);
    assert.equal(await schema.hasDeliveryOpsZoneColumns(db), false);
    assert.equal(await schema.hasDeliveryOpsSchema(db), false);
  });

  it("0010 applied: all probes true", async () => {
    const { db } = makeDb({
      tables: [...ops0009.tables, ...schema.DELIVERY_OPS_TABLES],
      columns: {
        orders: [...schema.SHIPPING_ORDER_COLUMNS, ...schema.DELIVERY_OPS_ORDER_COLUMNS],
        shipping_zones: [...schema.DELIVERY_OPS_ZONE_COLUMNS],
        products: ["requires_shipping"],
      },
    });
    assert.equal(await schema.hasDeliveryOpsTables(db), true);
    assert.equal(await schema.hasDeliveryOpsOrderColumns(db), true);
    assert.equal(await schema.hasDeliveryOpsZoneColumns(db), true);
    assert.equal(await schema.hasDeliveryOpsSchema(db), true);
    assert.equal(await schema.hasShippingSchema(db), true);
  });

  it("partial 0010 (missing one table / one column) => false", async () => {
    const { db } = makeDb({
      tables: [...ops0009.tables, "shipping_areas", "riders"],
      columns: {
        orders: [...schema.DELIVERY_OPS_ORDER_COLUMNS.slice(1)],
        shipping_zones: ["delivery_method"],
      },
    });
    assert.equal(await schema.hasDeliveryOpsTables(db), false);
    assert.equal(await schema.hasDeliveryOpsOrderColumns(db), false);
    assert.equal(await schema.hasDeliveryOpsZoneColumns(db), false);
    assert.equal(await schema.hasDeliveryOpsSchema(db), false);
  });

  it("probe failure => false; negative result cached, reset clears it", async () => {
    const failing = {
      async query() {
        throw new Error("boom");
      },
    } as never;
    assert.equal(await schema.hasDeliveryOpsSchema(failing), false);

    const applied = makeDb({
      tables: [...schema.DELIVERY_OPS_TABLES],
      columns: {
        orders: [...schema.DELIVERY_OPS_ORDER_COLUMNS],
        shipping_zones: [...schema.DELIVERY_OPS_ZONE_COLUMNS],
      },
    });
    // still negative-cached (30s) even though the DB is now fine
    assert.equal(await schema.hasDeliveryOpsTables(applied.db), false);
    schema.resetShippingSchemaCache();
    assert.equal(await schema.hasDeliveryOpsSchema(applied.db), true);
  });
});
