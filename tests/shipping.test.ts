/**
 * BATCH-12 shipping engine — pure matrix (no database).
 * Run: node --test tests/shipping.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  normaliseCity,
  normaliseProvince,
  parseZoneList,
  matchZone,
  isShippableItem,
  computeShippingAmount,
  shippableSubtotalAfterDiscount,
  quoteShippingFromLines,
  quoteShipping,
  resetShippingZonesCache,
  buildTrackingUrl,
  TRACKING_NUMBER_RE,
} = await import("../lib/shipping.ts");
const { validateShippingEnabledValue, parseShippingSettingsMap } = await import("../lib/shippingSettings.ts");

type Zone = Parameters<typeof matchZone>[0][number];

const lahore: Zone = {
  id: 1,
  name: "Lahore",
  cities: "Lahore\nKasur",
  provinces: null,
  is_default: false,
  rate: 200,
  free_min: 5000,
  estimate_text: "1-2 days",
  active: true,
  sort_order: 1,
};
const punjab: Zone = {
  id: 2,
  name: "Punjab",
  cities: null,
  provinces: "Punjab",
  is_default: false,
  rate: 300,
  free_min: null,
  estimate_text: null,
  active: true,
  sort_order: 2,
};
const rest: Zone = {
  id: 3,
  name: "Rest of Pakistan",
  cities: null,
  provinces: null,
  is_default: true,
  rate: 450,
  free_min: 10000,
  estimate_text: "3-5 days",
  active: true,
  sort_order: 3,
};
const zones = [rest, punjab, lahore]; // deliberately unsorted

describe("normalisation", () => {
  it("trims, lowercases, collapses spaces and strips punctuation", () => {
    assert.equal(normaliseCity("  LAHORE  "), "lahore");
    assert.equal(normaliseCity("Dera   Ghazi\tKhan"), "dera ghazi khan");
    assert.equal(normaliseCity("D.G. Khan"), "dg khan");
    assert.equal(normaliseCity("Rawalpindi,"), "rawalpindi");
    assert.equal(normaliseCity("St. John's-Town"), "st johnstown");
    assert.equal(normaliseProvince(" Khyber-Pakhtunkhwa "), "khyberpakhtunkhwa");
    assert.equal(normaliseProvince("SINDH"), "sindh");
  });
  it("handles null / undefined / empty", () => {
    assert.equal(normaliseCity(null), "");
    assert.equal(normaliseCity(undefined), "");
    assert.equal(normaliseProvince(""), "");
    assert.equal(normaliseProvince("   "), "");
  });
  it("parseZoneList splits on newline/comma/semicolon, normalises and de-duplicates", () => {
    assert.deepEqual(parseZoneList("Lahore\r\nKasur, kasur ; Multan"), ["lahore", "kasur", "multan"]);
    assert.deepEqual(parseZoneList(null), []);
    assert.deepEqual(parseZoneList(["A.B", " a b "]), ["ab", "a b"]);
  });
});

describe("matchZone", () => {
  it("city match wins over province and default", () => {
    assert.equal(matchZone(zones, "  lahore ", "Punjab")?.id, 1);
    assert.equal(matchZone(zones, "KASUR", "Sindh")?.id, 1);
  });
  it("province match when the city is not listed", () => {
    assert.equal(matchZone(zones, "Multan", "punjab")?.id, 2);
  });
  it("falls back to the active default zone", () => {
    assert.equal(matchZone(zones, "Karachi", "Sindh")?.id, 3);
    assert.equal(matchZone(zones, "", "")?.id, 3);
    assert.equal(matchZone(zones, undefined, undefined)?.id, 3);
  });
  it("returns null when nothing matches and there is no default", () => {
    assert.equal(matchZone([lahore, punjab], "Karachi", "Sindh"), null);
    assert.equal(matchZone([], "Lahore", "Punjab"), null);
  });
  it("ignores inactive zones for city, province and default", () => {
    const off = (z: Zone): Zone => ({ ...z, active: false });
    assert.equal(matchZone([off(lahore), punjab, rest], "Lahore", "Punjab")?.id, 2);
    assert.equal(matchZone([off(lahore), off(punjab), rest], "Lahore", "Punjab")?.id, 3);
    assert.equal(matchZone([off(lahore), off(punjab), off(rest)], "Lahore", "Punjab"), null);
    assert.equal(matchZone([lahore, punjab, off(rest)], "Karachi", "Sindh"), null);
  });
  it("accepts numeric active / is_default flags (DB shape)", () => {
    const db: Zone[] = [
      { ...lahore, active: 0 as never },
      { ...rest, is_default: 1 as never, active: 1 as never },
    ];
    assert.equal(matchZone(db, "Lahore", "")?.id, 3);
  });
  it("ties on the same city resolve by sort_order then id", () => {
    const a: Zone = { ...lahore, id: 10, name: "A", sort_order: 5 };
    const b: Zone = { ...lahore, id: 11, name: "B", sort_order: 1 };
    assert.equal(matchZone([a, b], "Lahore", "")?.id, 11);
  });
});

describe("isShippableItem", () => {
  it("requires_shipping = 1 ships; 0 does not", () => {
    assert.equal(isShippableItem({ requires_shipping: 1, stock: "In Stock", track_inventory: 1 }), true);
    assert.equal(isShippableItem({ requires_shipping: 0, stock: "In Stock", track_inventory: 1 }), false);
    assert.equal(isShippableItem({ requires_shipping: "1", stock: "5", track_inventory: 1 }), true);
    assert.equal(isShippableItem({ requires_shipping: "0", stock: "5", track_inventory: 1 }), false);
  });
  it("legacy digital marker (stock Digital + track_inventory 0) never ships", () => {
    assert.equal(isShippableItem({ requires_shipping: 1, stock: "Digital", track_inventory: 0 }), false);
  });
  it("Digital with inventory tracking, or untracked non-Digital, still ships", () => {
    assert.equal(isShippableItem({ requires_shipping: 1, stock: "Digital", track_inventory: 1 }), true);
    assert.equal(isShippableItem({ requires_shipping: 1, stock: "Available", track_inventory: 0 }), true);
  });
  it("requires_shipping 0 beats everything", () => {
    assert.equal(isShippableItem({ requires_shipping: 0, stock: "Digital", track_inventory: 0 }), false);
  });
  it("missing requires_shipping is the column default (ships)", () => {
    assert.equal(isShippableItem({ stock: "In Stock", track_inventory: 1 }), true);
    assert.equal(isShippableItem({}), true);
  });
});

describe("computeShippingAmount (free_min boundary)", () => {
  const zone = { rate: 200, free_min: 5000 };
  it("below free_min pays the rate", () => {
    assert.equal(computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: 4999.99 }), 200);
    assert.equal(computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: 0 }), 200);
  });
  it("EQUAL to free_min is free", () => {
    assert.equal(computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: 5000 }), 0);
  });
  it("above free_min is free", () => {
    assert.equal(computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: 5000.01 }), 0);
    assert.equal(computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: 99999 }), 0);
  });
  it("free_min null never waives the rate", () => {
    assert.equal(computeShippingAmount({ zone: { rate: 200, free_min: null }, shippableGoodsSubtotalAfterDiscount: 1e9 }), 200);
  });
  it("free_min 0 waives everything (base >= 0)", () => {
    assert.equal(computeShippingAmount({ zone: { rate: 200, free_min: 0 }, shippableGoodsSubtotalAfterDiscount: 0 }), 0);
  });
  it("no zone => 0; rate 0 => 0", () => {
    assert.equal(computeShippingAmount({ zone: null, shippableGoodsSubtotalAfterDiscount: 100 }), 0);
    assert.equal(computeShippingAmount({ zone: undefined, shippableGoodsSubtotalAfterDiscount: 100 }), 0);
    assert.equal(computeShippingAmount({ zone: { rate: 0, free_min: null }, shippableGoodsSubtotalAfterDiscount: 100 }), 0);
  });
  it("decimal rates are preserved to 2dp", () => {
    assert.equal(computeShippingAmount({ zone: { rate: 199.5, free_min: null }, shippableGoodsSubtotalAfterDiscount: 1 }), 199.5);
  });
});

describe("shippableSubtotalAfterDiscount (free_min base)", () => {
  it("no discount: shippable subtotal only (digital lines excluded)", () => {
    const base = shippableSubtotalAfterDiscount({
      lines: [
        { price: 3000, quantity: 1, shippable: true },
        { price: 2000, quantity: 1, shippable: false },
      ],
      discountAmount: 0,
    });
    assert.equal(base, 3000);
  });
  it("discount is allocated proportionally across ALL lines", () => {
    // goods 5000: shippable 4000 (80%), digital 1000. Discount 500 -> 400 allocated to shippable.
    const base = shippableSubtotalAfterDiscount({
      lines: [
        { price: 4000, quantity: 1, shippable: true },
        { price: 1000, quantity: 1, shippable: false },
      ],
      discountAmount: 500,
      goodsSubtotal: 5000,
    });
    assert.equal(base, 3600);
  });
  it("all-shippable basket: base = subtotal - discount", () => {
    assert.equal(
      shippableSubtotalAfterDiscount({ lines: [{ price: 2500, quantity: 2, shippable: true }], discountAmount: 100 }),
      4900
    );
  });
  it("never negative; nothing shippable => 0", () => {
    assert.equal(
      shippableSubtotalAfterDiscount({ lines: [{ price: 100, quantity: 1, shippable: true }], discountAmount: 500 }),
      0
    );
    assert.equal(
      shippableSubtotalAfterDiscount({ lines: [{ price: 100, quantity: 1, shippable: false }], discountAmount: 0 }),
      0
    );
  });
});

describe("quoteShippingFromLines matrix", () => {
  const ship = (price: number, quantity = 1) => ({ price, quantity, shippable: true });
  const digital = (price: number, quantity = 1) => ({ price, quantity, shippable: false });
  const q = (over: Partial<Parameters<typeof quoteShippingFromLines>[0]> & { lines: ReturnType<typeof ship>[] }) =>
    quoteShippingFromLines({ zones, city: "Lahore", province: "Punjab", discountAmount: 0, ...over });

  it("charges the matched zone rate below free_min and returns zone + estimate", () => {
    const r = q({ lines: [ship(1000)] });
    assert.equal(r.amount, 200);
    assert.equal(r.zoneName, "Lahore");
    assert.equal(r.estimateText, "1-2 days");
    assert.equal(r.hasShippableItems, true);
    assert.equal(r.unavailable, false);
  });
  it("free when the shippable base equals free_min exactly", () => {
    assert.equal(q({ lines: [ship(5000)] }).amount, 0);
  });
  it("free_min compares AFTER the discount", () => {
    // 5200 goods - 300 discount = 4900 < 5000 => pays
    assert.equal(q({ lines: [ship(5200)], discountAmount: 300 }).amount, 200);
    // 5200 - 200 = 5000 => free
    assert.equal(q({ lines: [ship(5200)], discountAmount: 200 }).amount, 0);
    // zone is still reported when free
    assert.equal(q({ lines: [ship(5200)], discountAmount: 200 }).zoneName, "Lahore");
  });
  it("digital lines do not count toward free_min", () => {
    // shippable 3000 + digital 3000: 3000 < 5000 => pays even though goods total 6000
    assert.equal(q({ lines: [ship(3000), digital(3000)] }).amount, 200);
  });
  it("only non-shippable lines => 0 shipping and no zone", () => {
    const r = q({ lines: [digital(999)] });
    assert.equal(r.amount, 0);
    assert.equal(r.zoneName, null);
    assert.equal(r.estimateText, null);
    assert.equal(r.hasShippableItems, false);
    assert.equal(r.unavailable, false);
  });
  it("legacy digital marker is excluded via isShippableItem", () => {
    const lines = [
      { price: 500, quantity: 1, shippable: isShippableItem({ requires_shipping: 1, stock: "Digital", track_inventory: 0 }) },
    ];
    const r = q({ lines });
    assert.equal(r.amount, 0);
    assert.equal(r.hasShippableItems, false);
  });
  it("province zone applies when the city is not listed", () => {
    const r = q({ city: "Multan", province: "Punjab", lines: [ship(100)] });
    assert.equal(r.zoneName, "Punjab");
    assert.equal(r.amount, 300);
    assert.equal(r.estimateText, null);
  });
  it("default zone applies elsewhere with its own free_min", () => {
    assert.equal(q({ city: "Karachi", province: "Sindh", lines: [ship(9999)] }).amount, 450);
    assert.equal(q({ city: "Karachi", province: "Sindh", lines: [ship(10000)] }).amount, 0);
    assert.equal(q({ city: "Karachi", province: "Sindh", lines: [ship(1)] }).zoneName, "Rest of Pakistan");
  });
  it("inactive zones are ignored (inactive Lahore falls through to province)", () => {
    const r = quoteShippingFromLines({
      zones: [{ ...lahore, active: false }, punjab, rest],
      lines: [ship(100)],
      city: "Lahore",
      province: "Punjab",
      discountAmount: 0,
    });
    assert.equal(r.zoneName, "Punjab");
    assert.equal(r.amount, 300);
  });
  it("shippable items but no zone and no default => unavailable (fail closed)", () => {
    const r = quoteShippingFromLines({
      zones: [lahore],
      lines: [ship(100)],
      city: "Karachi",
      province: "Sindh",
      discountAmount: 0,
    });
    assert.equal(r.unavailable, true);
    assert.equal(r.zoneName, null);
  });
  it("quantity multiplies the line", () => {
    assert.equal(q({ lines: [ship(2500, 2)] }).amount, 0);
    assert.equal(q({ lines: [ship(2499, 2)] }).amount, 200);
  });
  it("normalised city input matches (case/space/punctuation)", () => {
    assert.equal(q({ city: "  LAHORE. ", lines: [ship(1)] }).zoneName, "Lahore");
  });
});

describe("quoteShipping (DB loader with a mocked connection)", () => {
  it("loads product flags, zones and computes the quote", async () => {
    resetShippingZonesCache();
    const calls: string[] = [];
    const db = {
      async query(sql: string) {
        calls.push(sql);
        if (/FROM products/.test(sql)) {
          return [
            [
              { id: 1, requires_shipping: 1, stock: "In Stock", track_inventory: 1 },
              { id: 2, requires_shipping: 1, stock: "Digital", track_inventory: 0 },
              { id: 3, requires_shipping: 0, stock: "In Stock", track_inventory: 1 },
            ],
          ];
        }
        return [
          [
            { id: 1, name: "Lahore", cities: "Lahore", provinces: null, is_default: 0, rate: "200.00", free_min: "5000.00", estimate_text: "1-2 days", active: 1, sort_order: 0 },
            { id: 9, name: "Default", cities: null, provinces: null, is_default: 1, rate: "450.00", free_min: null, estimate_text: null, active: 1, sort_order: 9 },
          ],
        ];
      },
    };
    const r = await quoteShipping(db as never, {
      items: [
        { product_id: 1, price: 3000, quantity: 1 },
        { product_id: 2, price: 5000, quantity: 1 },
        { product_id: 3, price: 5000, quantity: 1 },
      ],
      city: "lahore",
      province: "",
      discountAmount: 0,
    });
    // Only product 1 ships: base 3000 < 5000 => 200
    assert.equal(r.amount, 200);
    assert.equal(r.zoneName, "Lahore");
    assert.equal(r.estimateText, "1-2 days");
    assert.ok(calls.some((s) => /requires_shipping/.test(s)));
    resetShippingZonesCache();
  });
});

describe("shipping flag settings", () => {
  it("defaults off and parses 0/1 only", () => {
    assert.equal(parseShippingSettingsMap({}).shipping_enabled, false);
    assert.equal(parseShippingSettingsMap({ shipping_enabled: "1" }).shipping_enabled, true);
    assert.equal(parseShippingSettingsMap({ shipping_enabled: "0" }).shipping_enabled, false);
    assert.equal(parseShippingSettingsMap({ shipping_enabled: "yes" }).shipping_enabled, false);
    assert.equal(parseShippingSettingsMap({ shipping_enabled: "" }).shipping_enabled, false);
  });
  it("validateShippingEnabledValue accepts only 0 and 1", () => {
    assert.deepEqual(validateShippingEnabledValue("1"), { ok: true, value: "1" });
    assert.deepEqual(validateShippingEnabledValue(" 0 "), { ok: true, value: "0" });
    assert.equal(validateShippingEnabledValue("2").ok, false);
    assert.equal(validateShippingEnabledValue("true").ok, false);
    assert.equal(validateShippingEnabledValue(null).ok, false);
  });
});

describe("tracking url / number", () => {
  it("builds an https link and URL-encodes {tracking}", () => {
    assert.equal(
      buildTrackingUrl("https://courier.example/track?id={tracking}", "AB-12/3 4"),
      "https://courier.example/track?id=AB-12%2F3%204"
    );
  });
  it("rejects http, javascript:, missing token and missing tracking", () => {
    assert.equal(buildTrackingUrl("http://c.example/{tracking}", "ABC123"), null);
    assert.equal(buildTrackingUrl("javascript:alert({tracking})", "ABC123"), null);
    assert.equal(buildTrackingUrl("https://c.example/", "ABC123"), null);
    assert.equal(buildTrackingUrl("https://c.example/{tracking}", ""), null);
    assert.equal(buildTrackingUrl(null, "ABC123"), null);
  });
  it("tracking number is 3-100 of [A-Za-z0-9-]", () => {
    assert.ok(TRACKING_NUMBER_RE.test("ABC-123"));
    assert.ok(TRACKING_NUMBER_RE.test("a".repeat(100)));
    assert.ok(!TRACKING_NUMBER_RE.test("ab"));
    assert.ok(!TRACKING_NUMBER_RE.test("a".repeat(101)));
    assert.ok(!TRACKING_NUMBER_RE.test("ABC 123"));
    assert.ok(!TRACKING_NUMBER_RE.test("ABC_123"));
    assert.ok(!TRACKING_NUMBER_RE.test("ABC/123"));
  });
});
