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
  hasRequiresShippingColumn,
  hasShippingOrderColumns,
  hasShippingTables,
} from "./shippingSchema";

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
};

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
};

export type QuoteLine = {
  price: number;
  quantity: number;
  shippable: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** trim, lowercase, strip punctuation (letters/digits/space only), collapse whitespace. */
function normaliseText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseCity(value: unknown): string {
  return normaliseText(value);
}

export function normaliseProvince(value: unknown): string {
  return normaliseText(value);
}

/** Split an admin-entered list (newline / comma / semicolon / pipe separated) into normalised, unique entries. */
export function parseZoneList(raw: string | string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\r\n,;|]+/);
  const out: string[] = [];
  for (const p of parts) {
    const n = normaliseText(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

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
}): ShippingQuote {
  const hasShippableItems = input.lines.some((l) => l.shippable);
  if (!hasShippableItems) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: false,
      unavailable: false,
    };
  }

  const zone = matchZone(input.zones, input.city, input.province);
  if (!zone) {
    return {
      amount: 0,
      zoneId: null,
      zoneName: null,
      estimateText: null,
      hasShippableItems: true,
      unavailable: true,
    };
  }

  const base = shippableSubtotalAfterDiscount({
    lines: input.lines,
    discountAmount: input.discountAmount,
    goodsSubtotal: input.goodsSubtotal,
  });
  const amount = computeShippingAmount({ zone, shippableGoodsSubtotalAfterDiscount: base });
  const estimate = zone.estimate_text ? String(zone.estimate_text).trim() : "";
  return {
    amount,
    zoneId: zone.id,
    zoneName: zone.name,
    estimateText: estimate || null,
    hasShippableItems: true,
    unavailable: false,
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const ZONES_CACHE_TTL_MS = 5_000;
let zonesCache: { at: number; zones: ShippingZone[] } | null = null;

/** Test-only, and called by every admin zone write so edits apply immediately. */
export function resetShippingZonesCache(): void {
  zonesCache = null;
}

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
