/**
 * Shipping zones + server-side shipping quote (SANDY-BATCH-12, SHIPPING-01).
 *
 * Pure helpers (normalise / match / shippable / amount / quote-from-lines) plus DB helpers
 * (loadShippingZones with a short TTL cache, quoteShipping, readiness counts). The client NEVER
 * supplies a shipping amount: orders.ts / tax-quote.ts / eligibility.ts call into this module only
 * when site_content.shipping_enabled = 1; with the flag off none of this code runs.
 *
 * FREE-SHIPPING BASE (documented owner decision): `free_min` is compared against the
 * SHIPPABLE GOODS SUBTOTAL AFTER DISCOUNT. The order discount (coupon) is allocated across lines
 * proportionally to line value, so the shippable base is
 *     shippableSubtotal - discount * shippableSubtotal / goodsSubtotal
 * Digital / non-shippable lines never count toward the base and never trigger a charge. If NO line
 * ships, shipping is 0 with no zone. Shipping itself is never discounted by the coupon (the coupon
 * base is the goods subtotal when the flag is on, which also removes the shipping<->discount cycle).
 *
 * Tax maths is untouched: the amount computed here is passed into computeOrderTaxTotals unchanged.
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  hasDeliveryOpsSchema,
  hasDeliveryOpsZoneColumns,
  hasRequiresShippingColumn,
  hasShippingOrderColumns,
  hasShippingTables,
} from "./shippingSchema";
import { cityHasActiveAreas, findSelectableArea, resolveAreaPath, resolveZoneIdFromArea } from "./shippingAreas";
export {
  normaliseCity,
  normaliseProvince,
  parseZoneList,
} from "./shippingNormalise";
import { normaliseCity, normaliseProvince, parseZoneList } from "./shippingNormalise";

type Queryable = Pick<Pool | PoolConnection, "query">;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShippingZone = {
  id: number;
  name: string;
  /** One city per line / comma / semicolon in the admin form; raw text or pre-split list. */
  cities: string | string[] | null;
  provinces: string | string[] | null;
  is_default: boolean | number;
  rate: number;
  free_min: number | null;
  estimate_text: string | null;
  active: boolean | number;
  sort_order?: number;
  /**
   * SANDY-BATCH-17 (migration 0010). Absent unless enriched via loadZoneDeliveryMethods; absent is
   * treated as 'courier' so the plain loadShippingZones query keeps ab26978 parity.
   */
  delivery_method?: ZoneDeliveryMethod;
  /** PKT wall-clock TIME ("HH:MM[:SS]") for own-rider same-day delivery; owner data, no tz conversion. */
  same_day_cutoff?: string | null;
};

export type ZoneDeliveryMethod = "courier" | "own_rider";

export type ShippingFulfilment = "delivery" | "pickup";

/** Row of shipping_areas (migration 0010). Tree via parent_id; zone_id optionally pins a zone. */
export type ShippingArea = {
  id: number;
  city: string;
  name: string;
  parent_id: number | null;
  zone_id: number | null;
  active: boolean | number;
  sort_order: number;
};

/** Shown when restrict-to-zones is on and no active zone covers the destination. */
export const AREA_NOT_SERVED_MESSAGE = "We don't deliver to this area yet.";
/** Server-side area requirement (orders only): the city has active areas but none / "other" was chosen. */
export const AREA_REQUIRED_MESSAGE = "Please select your delivery area.";

export type ShippableItemFlags = {
  requires_shipping?: unknown;
  stock?: unknown;
  track_inventory?: unknown;
};

export type ShippingQuote = {
  /** Server-computed shipping in PKR (2dp). 0 when nothing ships or the order is free-shipping. */
  amount: number;
  zoneId: number | null;
  zoneName: string | null;
  estimateText: string | null;
  /** True when at least one line item needs shipping. */
  hasShippableItems: boolean;
  /**
   * True when items need shipping but no active zone matched and there is no active default
   * zone. Callers must fail closed (503) instead of guessing a price.
   */
  unavailable: boolean;
  /**
   * SANDY-BATCH-17. The keys below are set ONLY on delivery-ops paths (areas array supplied, pickup
   * enabled, or an own-rider zone). With every flag off they are absent (byte parity with ab26978).
   * deliverable: false only when restrict-to-zones refused the destination (default true).
   */
  deliverable?: boolean;
  refuseReason?: string | null;
  /** True when deliverable is false only because the city has active areas and no area / "other" was chosen. */
  areaRequired?: boolean;
  /** "Parent > Child" snapshot for orders.shipping_area. */
  shippingAreaSnapshot?: string | null;
  deliveryMethod?: string | null;
  fulfilment?: ShippingFulfilment;
};

export type QuoteLine = {
  price: number;
  quantity: number;
  shippable: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers (normaliseCity / normaliseProvince / parseZoneList → shippingNormalise)
// ---------------------------------------------------------------------------

function isOn(v: unknown): boolean {
  return v === true || Number(v) === 1;
}

function compareZones(a: ShippingZone, b: ShippingZone): number {
  const so = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  return so !== 0 ? so : a.id - b.id;
}

/**
 * Active city match -> active province match -> active default zone. Inactive zones are ignored
 * entirely. Ties are broken by (sort_order, id). Returns null when nothing matches.
 */
export function matchZone(
  zones: readonly ShippingZone[],
  city: unknown,
  province: unknown
): ShippingZone | null {
  const active = zones.filter((z) => isOn(z.active)).sort(compareZones);

  const c = normaliseCity(city);
  if (c) {
    for (const z of active) {
      if (parseZoneList(z.cities).includes(c)) return z;
    }
  }

  const p = normaliseProvince(province);
  if (p) {
    for (const z of active) {
      if (parseZoneList(z.provinces).includes(p)) return z;
    }
  }

  for (const z of active) {
    if (isOn(z.is_default)) return z;
  }
  return null;
}

export type MatchZoneWithAreasInput = {
  city: unknown;
  province: unknown;
  areaId?: unknown;
  /** shipping_restrict_to_zones: skip the default zone and refuse when nothing else matches. */
  restrictToZones?: boolean;
};

export type MatchZoneWithAreasResult = {
  zone: ShippingZone | null;
  /** "Parent > Child" of the validated selected area, else null. */
  areaSnapshot: string | null;
  /** True only when restrict-to-zones is on and no active zone covers the destination. */
  refused: boolean;
};

/**
 * Area-aware zone match (shipping_areas_enabled and/or restrict-to-zones). Server-side only: a client
 * area id is used only when the area is active AND belongs to the selected city.
 *
 * Precedence (first hit wins; inactive zones/areas never match):
 *   1. selected area's own zone_id (active zone)
 *   2. ancestors' zone_id, nearest first
 *   3. active zone listing the city
 *   4. active zone listing the province
 *   5. active default zone (SKIPPED when restrictToZones)
 *   6. restrictToZones and nothing matched => refused
 * Ties between zones use (sort_order, id). matchZone() is untouched; this is a separate function.
 */
export function matchZoneWithAreas(
  zones: readonly ShippingZone[],
  areas: readonly ShippingArea[],
  input: MatchZoneWithAreasInput
): MatchZoneWithAreasResult {
  const restrict = input.restrictToZones === true;
  const active = zones.filter((z) => isOn(z.active)).sort(compareZones);

  const area = findSelectableArea(areas, input.areaId, input.city);
  const areaSnapshot = area ? resolveAreaPath(areas, area.id) : null;

  if (area) {
    const activeIds = new Set(active.map((z) => Number(z.id)));
    const zoneId = resolveZoneIdFromArea(areas, area.id, activeIds);
    if (zoneId !== null) {
      const z = active.find((x) => Number(x.id) === zoneId);
      if (z) return { zone: z, areaSnapshot, refused: false };
    }
  }

  const c = normaliseCity(input.city);
  if (c) {
    for (const z of active) {
      if (parseZoneList(z.cities).includes(c)) return { zone: z, areaSnapshot, refused: false };
    }
  }

  const p = normaliseProvince(input.province);
  if (p) {
    for (const z of active) {
      if (parseZoneList(z.provinces).includes(p)) return { zone: z, areaSnapshot, refused: false };
    }
  }

  if (!restrict) {
    for (const z of active) {
      if (isOn(z.is_default)) return { zone: z, areaSnapshot, refused: false };
    }
  }

  return { zone: null, areaSnapshot, refused: restrict };
}

const CUTOFF_RE = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

/**
 * Own-rider estimate text. With a valid cutoff (MySQL TIME "HH:MM" / "HH:MM:SS", stored as PKT
 * wall-clock owner data, so it is only re-formatted, never timezone-converted) returns
 * "Same-day delivery for orders before HH:MM". Otherwise the zone's estimate text (trimmed) or null.
 */
export function formatSameDayEstimate(
  cutoff: string | null | undefined,
  estimateText: string | null | undefined
): string | null {
  if (typeof cutoff === "string") {
    const m = CUTOFF_RE.exec(cutoff.trim());
    if (m) {
      const h = Number(m[1]);
      if (h >= 0 && h <= 23) {
        return `Same-day delivery for orders before ${String(h).padStart(2, "0")}:${m[2]}`;
      }
    }
  }
  const text = estimateText === null || estimateText === undefined ? "" : String(estimateText).trim();
  return text || null;
}

/**
 * A line ships iff requires_shipping = 1 AND it is not the legacy digital marker
 * (stock === 'Digital' with track_inventory = 0). A missing requires_shipping value is the column
 * default (1).
 */
export function isShippableItem(item: ShippableItemFlags): boolean {
  const rs = item.requires_shipping;
  const requires = rs === undefined || rs === null ? true : Number(rs) === 1;
  if (!requires) return false;
  const legacyDigital = item.stock === "Digital" && Number(item.track_inventory) === 0;
  return !legacyDigital;
}

function toPaisa(n: number): number {
  return Math.round(n * 100);
}

function fromPaisa(p: number): number {
  return Math.round(p) / 100;
}

/**
 * Zone rate unless free_min is set and the shippable-after-discount base reaches it
 * (base >= free_min, i.e. equal qualifies). No zone => 0.
 */
export function computeShippingAmount(input: {
  zone: Pick<ShippingZone, "rate" | "free_min"> | null | undefined;
  shippableGoodsSubtotalAfterDiscount: number;
}): number {
  const { zone } = input;
  if (!zone) return 0;
  const rate = Number(zone.rate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const base = Number(input.shippableGoodsSubtotalAfterDiscount);
  const freeMin = zone.free_min === null || zone.free_min === undefined ? null : Number(zone.free_min);
  if (freeMin !== null && Number.isFinite(freeMin) && Number.isFinite(base)) {
    if (toPaisa(base) >= toPaisa(freeMin)) return 0;
  }
  return fromPaisa(toPaisa(rate));
}

/**
 * Shippable goods subtotal after the order discount, allocated proportionally across lines.
 * Pure integer-paisa arithmetic to keep the free_min boundary exact.
 */
export function shippableSubtotalAfterDiscount(input: {
  lines: readonly QuoteLine[];
  discountAmount: number;
  goodsSubtotal?: number;
}): number {
  let shippablePaisa = 0;
  let allPaisa = 0;
  for (const l of input.lines) {
    const linePaisa = toPaisa(l.price * l.quantity);
    allPaisa += linePaisa;
    if (l.shippable) shippablePaisa += linePaisa;
  }
  const goodsPaisa =
    input.goodsSubtotal !== undefined && Number.isFinite(input.goodsSubtotal) && input.goodsSubtotal > 0
      ? toPaisa(input.goodsSubtotal)
      : allPaisa;
  const discountPaisa = Math.max(0, toPaisa(Number(input.discountAmount) || 0));
  if (shippablePaisa <= 0) return 0;
  if (goodsPaisa <= 0 || discountPaisa <= 0) return fromPaisa(shippablePaisa);
  const allocated = Math.round((discountPaisa * shippablePaisa) / goodsPaisa);
  return fromPaisa(Math.max(0, shippablePaisa - allocated));
}

/** Pure quote from pre-resolved lines (used by orders.ts, which already holds the product rows). */
export function quoteShippingFromLines(input: {
  zones: readonly ShippingZone[];
  lines: readonly QuoteLine[];
  city: unknown;
  province: unknown;
  discountAmount: number;
  goodsSubtotal?: number;
  /** SANDY-BATCH-17 (all optional; omitted => identical to the ab26978 behaviour). */
  areaId?: unknown;
  /** Providing the array (even empty) selects the area-aware matcher (shipping_areas_enabled). */
  areas?: readonly ShippingArea[];
  restrictToZones?: boolean;
  /**
   * Orders only: when true (with `areas`), a delivery to a city that has at least one ACTIVE area needs a
   * valid selectable areaId OR otherArea = true (explicit "Other area in city" = city-level match).
   * Omitted => no requirement (tax-quote / eligibility stay advisory; pure-function callers unchanged).
   */
  requireAreaSelection?: boolean;
  otherArea?: boolean;
  fulfilment?: ShippingFulfilment;
  pickupEnabled?: boolean;
}): ShippingQuote {
  const hasShippableItems = input.lines.some((l) => l.shippable);
  const pickupOn = input.pickupEnabled === true;

  // Pickup: no zone, no shipping charge, even with shippable items.
  if (input.fulfilment === "pickup" && pickupOn) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems,
      unavailable: false,
      deliverable: true,
      refuseReason: null,
      shippingAreaSnapshot: null,
      deliveryMethod: null,
      fulfilment: "pickup",
    };
  }

  const restrict = input.restrictToZones === true;
  const areaPath = input.areas !== undefined || restrict;
  const opsPath = areaPath || pickupOn;

  if (!hasShippableItems) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: false,
      unavailable: false,
      ...(opsPath ? { deliverable: true, fulfilment: "delivery" as const } : {}),
    };
  }

  let zone: ShippingZone | null;
  let areaSnapshot: string | null = null;
  if (
    areaPath &&
    input.requireAreaSelection === true &&
    input.areas !== undefined &&
    input.otherArea !== true &&
    cityHasActiveAreas(input.areas, input.city) &&
    findSelectableArea(input.areas, input.areaId, input.city) === null
  ) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: true,
      unavailable: false,
      deliverable: false,
      areaRequired: true,
      refuseReason: AREA_REQUIRED_MESSAGE,
      shippingAreaSnapshot: null,
      deliveryMethod: null,
      fulfilment: "delivery",
    };
  }

  if (areaPath) {
    const m = matchZoneWithAreas(input.zones, input.areas ?? [], {
      city: input.city,
      province: input.province,
      areaId: input.areaId,
      restrictToZones: restrict,
    });
    if (m.refused) {
      return {
        amount: 0,
        zoneId: null,
        zoneName: null,
        estimateText: null,
        hasShippableItems: true,
        unavailable: false,
        deliverable: false,
        refuseReason: AREA_NOT_SERVED_MESSAGE,
        shippingAreaSnapshot: m.areaSnapshot,
        deliveryMethod: null,
        fulfilment: "delivery",
      };
    }
    zone = m.zone;
    areaSnapshot = m.areaSnapshot;
  } else {
    zone = matchZone(input.zones, input.city, input.province);
  }

  if (!zone) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: true,
      unavailable: true,
      ...(opsPath ? { deliverable: true, fulfilment: "delivery" as const } : {}),
    };
  }

  const base = shippableSubtotalAfterDiscount({
    lines: input.lines,
    discountAmount: input.discountAmount,
    goodsSubtotal: input.goodsSubtotal,
  });
  const amount = computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: base });
  const ownRider = zone.delivery_method === "own_rider";
  const estimate = ownRider
    ? formatSameDayEstimate(zone.same_day_cutoff, zone.estimate_text)
    : zone.estimate_text
      ? String(zone.estimate_text).trim()
      : "";
  const quote: ShippingQuote = {
    amount,
    zoneId: zone.id,
    zoneName: zone.name,
    estimateText: estimate || null,
    hasShippableItems: true,
    unavailable: false,
  };
  if (opsPath || ownRider) {
    quote.deliverable = true;
    quote.deliveryMethod = zone.delivery_method ?? "courier";
    quote.fulfilment = "delivery";
    if (areaPath) quote.shippingAreaSnapshot = areaSnapshot;
  }
  return quote;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const ZONES_CACHE_TTL_MS = 5_000;
let zonesCache: { at: number; zones: ShippingZone[] } | null = null;

/** Test-only, and called by every admin zone write so edits apply immediately. */
export function resetShippingZonesCache(): void {
  zonesCache = null;
  zoneOpsCache = null;
}

let zoneOpsCache: { at: number; byId: Map<number, ZoneDeliveryOps> } | null = null;

export type ZoneDeliveryOps = {
  delivery_method: ZoneDeliveryMethod;
  same_day_cutoff: string | null;
};

function parseMoney(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function mapZoneRow(row: RowDataPacket): ShippingZone {
  const freeMinRaw = row.free_min;
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    cities: row.cities === null || row.cities === undefined ? null : String(row.cities),
    provinces: row.provinces === null || row.provinces === undefined ? null : String(row.provinces),
    is_default: Number(row.is_default) === 1,
    rate: parseMoney(row.rate),
    free_min: freeMinRaw === null || freeMinRaw === undefined ? null : parseMoney(freeMinRaw),
    estimate_text:
      row.estimate_text === null || row.estimate_text === undefined ? null : String(row.estimate_text),
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order ?? 0),
  };
}

/** All zones (active and inactive), cached for a few seconds. Throws if the table is missing. */
export async function loadShippingZones(db: Queryable): Promise<ShippingZone[]> {
  const now = Date.now();
  if (zonesCache && now - zonesCache.at < ZONES_CACHE_TTL_MS) return zonesCache.zones;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, cities, provinces, is_default, rate, free_min, estimate_text, active, sort_order
     FROM shipping_zones ORDER BY sort_order ASC, id ASC`
  );
  const zones = (Array.isArray(rows) ? rows : []).map(mapZoneRow);
  zonesCache = { at: now, zones };
  return zones;
}

/**
 * SANDY-BATCH-17: per-zone delivery_method / same_day_cutoff (migration 0010). loadShippingZones keeps
 * its original column list for parity; paths that need own-rider data call this (or
 * enrichZonesWithDeliveryOps). Returns an empty map when the 0010 zone columns are absent, so an
 * un-migrated database simply behaves as "every zone is courier". Cached for a few seconds.
 */
export async function loadZoneDeliveryMethods(
  db: Queryable
): Promise<Map<number, ZoneDeliveryOps>> {
  const now = Date.now();
  if (zoneOpsCache && now - zoneOpsCache.at < ZONES_CACHE_TTL_MS) return zoneOpsCache.byId;
  const byId = new Map<number, ZoneDeliveryOps>();
  if (await hasDeliveryOpsZoneColumns(db)) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, delivery_method, same_day_cutoff FROM shipping_zones`
    );
    for (const r of Array.isArray(rows) ? rows : []) {
      const cutoff =
        r.same_day_cutoff === null || r.same_day_cutoff === undefined
          ? null
          : String(r.same_day_cutoff).trim() || null;
      byId.set(Number(r.id), {
        delivery_method: String(r.delivery_method ?? "") === "own_rider" ? "own_rider" : "courier",
        same_day_cutoff: cutoff,
      });
    }
  }
  zoneOpsCache = { at: now, byId };
  return byId;
}

/** Pure: copy zones with delivery_method / same_day_cutoff filled from the map (default courier / null). */
export function enrichZonesWithDeliveryOps(
  zones: readonly ShippingZone[],
  byId: ReadonlyMap<number, ZoneDeliveryOps>
): ShippingZone[] {
  return zones.map((z) => {
    const ops = byId.get(Number(z.id));
    return {
      ...z,
      delivery_method: ops?.delivery_method ?? "courier",
      same_day_cutoff: ops?.same_day_cutoff ?? null,
    };
  });
}

export type QuoteShippingInput = {
  /** Authoritative priced lines (server-resolved price). */
  items: ReadonlyArray<{ product_id: number; price: number; quantity: number }>;
  city: unknown;
  province: unknown;
  discountAmount: number;
  goodsSubtotal?: number;
};

/**
 * Loads products.requires_shipping / stock / track_inventory, resolves the zone and returns the
 * server-authoritative quote. Throws on DB errors (callers translate to 503).
 */
export async function quoteShipping(
  db: Queryable,
  input: QuoteShippingInput
): Promise<ShippingQuote> {
  const ids = [...new Set(input.items.map((i) => i.product_id))];
  const flags = new Map<number, ShippableItemFlags>();
  if (ids.length > 0) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, requires_shipping, stock, track_inventory FROM products
       WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    for (const r of Array.isArray(rows) ? rows : []) {
      flags.set(Number(r.id), {
        requires_shipping: r.requires_shipping,
        stock: r.stock,
        track_inventory: r.track_inventory,
      });
    }
  }

  const lines: QuoteLine[] = input.items.map((i) => ({
    price: i.price,
    quantity: i.quantity,
    // An unknown product cannot be priced anyway; treat as shippable (callers reject it earlier).
    shippable: isShippableItem(flags.get(i.product_id) ?? {}),
  }));

  const zones = await loadShippingZones(db);
  return quoteShippingFromLines({
    zones,
    lines,
    city: input.city,
    province: input.province,
    discountAmount: input.discountAmount,
    goodsSubtotal: input.goodsSubtotal,
  });
}

/** Count of ACTIVE default zones (uncached; used for the enable gate and admin readiness). */
export async function countActiveDefaultZones(db: Queryable): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM shipping_zones WHERE active = 1 AND is_default = 1`
  );
  return Number((Array.isArray(rows) ? rows[0]?.c : 0) || 0);
}

/** Count of ACTIVE zones of any kind (uncached; used for the restrict-to-zones enable gate). */
export async function countActiveZones(db: Queryable): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM shipping_zones WHERE active = 1`
  );
  return Number((Array.isArray(rows) ? rows[0]?.c : 0) || 0);
}

/**
 * Enable gate for shipping_enabled (pure): exactly ONE active default zone, OR restrict-to-zones is on
 * with at least one active zone (no default needed because unmatched destinations are refused).
 */
export function canEnableShipping(input: {
  activeDefaultZones: number;
  restrictOn: boolean;
  activeZones: number;
}): boolean {
  if (input.activeDefaultZones === 1) return true;
  return input.restrictOn === true && input.activeZones >= 1;
}

/**
 * Enable gate for shipping_restrict_to_zones (pure): area matching is on, or at least one active zone
 * lists cities / provinces (otherwise restrict would refuse every destination).
 */
export function canEnableRestrict(input: {
  areasEnabled: boolean;
  hasListedCitiesOrProvinces: boolean;
}): boolean {
  return input.areasEnabled === true || input.hasListedCitiesOrProvinces === true;
}

/** Pure: does any ACTIVE zone list at least one city or province? */
export function hasListedCitiesOrProvinces(zones: readonly ShippingZone[]): boolean {
  return zones.some(
    (z) =>
      isOn(z.active) &&
      (parseZoneList(z.cities).length > 0 || parseZoneList(z.provinces).length > 0)
  );
}

export type DeliveryOpsReadiness = {
  schema: boolean;
  activeZones: number;
  activeDefaultZones: number;
};

/**
 * SANDY-BATCH-17 readiness for the delivery-ops flags. Separate from getShippingReadiness so the
 * existing admin shipping-settings response shape is unchanged.
 */
export async function getDeliveryOpsReadiness(db: Queryable): Promise<DeliveryOpsReadiness> {
  const schema = await hasDeliveryOpsSchema(db);
  let activeZones = 0;
  let activeDefaultZones = 0;
  if (await hasShippingTables(db)) {
    try {
      activeZones = await countActiveZones(db);
      activeDefaultZones = await countActiveDefaultZones(db);
    } catch {
      activeZones = 0;
      activeDefaultZones = 0;
    }
  }
  return { schema, activeZones, activeDefaultZones };
}

export type ShippingReadiness = {
  tables: boolean;
  orderColumns: boolean;
  requiresShippingColumn: boolean;
  activeDefaultZones: number;
  /** Safe to flip shipping_enabled to 1. */
  ready: boolean;
};

export async function getShippingReadiness(db: Queryable): Promise<ShippingReadiness> {
  const tables = await hasShippingTables(db);
  const orderColumns = await hasShippingOrderColumns(db);
  const requiresShippingColumn = await hasRequiresShippingColumn(db);
  let activeDefaultZones = 0;
  if (tables) {
    try {
      activeDefaultZones = await countActiveDefaultZones(db);
    } catch {
      activeDefaultZones = 0;
    }
  }
  return {
    tables,
    orderColumns,
    requiresShippingColumn,
    activeDefaultZones,
    ready: tables && orderColumns && requiresShippingColumn && activeDefaultZones === 1,
  };
}

/** Build the public tracking URL: https only, {tracking} URL-encoded. Null when unsafe / incomplete. */
export function buildTrackingUrl(
  template: unknown,
  trackingNumber: unknown
): string | null {
  if (typeof template !== "string" || typeof trackingNumber !== "string") return null;
  const t = template.trim();
  const n = trackingNumber.trim();
  if (!t || !n || !t.includes("{tracking}")) return null;
  const url = t.split("{tracking}").join(encodeURIComponent(n));
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** Tracking numbers: 3-100 chars of [A-Za-z0-9-]. */
export const TRACKING_NUMBER_RE = /^[A-Za-z0-9-]{3,100}$/;
