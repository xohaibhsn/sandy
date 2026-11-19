/**
 * Shipping areas (SANDY-BATCH-17 delivery ops, migration 0010).
 *
 * An area belongs to one city and may have a parent area (tree), e.g. "Model Town" > "Block A".
 * Pure tree helpers (path snapshot, ancestor walk, cycle / duplicate checks) plus one DB loader with a
 * short TTL cache. NO hardcoded localities: every row comes from the admin-managed shipping_areas table.
 *
 * The app never creates or alters tables. Callers must probe hasDeliveryOpsTables (lib/shippingSchema.ts)
 * before loading when a flag is ON; a missing table makes loadShippingAreas throw (callers answer 503).
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ShippingArea } from "./shipping";
import { normaliseText } from "./shippingNormalise";

type Queryable = Pick<Pool | PoolConnection, "query">;

/** orders.shipping_area is VARCHAR(160). */
export const SHIPPING_AREA_SNAPSHOT_MAX = 160;
export const SHIPPING_AREA_PATH_SEPARATOR = " > ";

/** Guard against corrupt data (a parent loop). Real trees are a few levels deep. */
const MAX_TREE_DEPTH = 32;

function isOn(v: unknown): boolean {
  return v === true || Number(v) === 1;
}

function toId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function findAreaById(
  areas: readonly ShippingArea[],
  areaId: unknown
): ShippingArea | null {
  const id = toId(areaId);
  if (id === null) return null;
  for (const a of areas) {
    if (Number(a.id) === id) return a;
  }
  return null;
}

/**
 * The area itself first, then its parent, grandparent, ... up to the root. Stops at a missing parent
 * or on a cycle (each id is visited at most once). Empty when the area is unknown.
 */
export function getAncestorChain(
  areas: readonly ShippingArea[],
  areaId: unknown
): ShippingArea[] {
  const chain: ShippingArea[] = [];
  const seen = new Set<number>();
  let current = findAreaById(areas, areaId);
  while (current && chain.length < MAX_TREE_DEPTH) {
    const id = Number(current.id);
    if (seen.has(id)) break;
    seen.add(id);
    chain.push(current);
    current = current.parent_id === null || current.parent_id === undefined
      ? null
      : findAreaById(areas, current.parent_id);
  }
  return chain;
}

/**
 * Snapshot stored on the order: "Parent > Child" (root first), truncated to the column width.
 * Null when the area does not exist.
 */
export function resolveAreaPath(
  areas: readonly ShippingArea[],
  areaId: unknown
): string | null {
  const chain = getAncestorChain(areas, areaId);
  if (chain.length === 0) return null;
  const path = chain
    .map((a) => String(a.name ?? "").trim())
    .reverse()
    .join(SHIPPING_AREA_PATH_SEPARATOR);
  return path.length > SHIPPING_AREA_SNAPSHOT_MAX
    ? path.slice(0, SHIPPING_AREA_SNAPSHOT_MAX)
    : path;
}

/**
 * A client-supplied area id is only usable when the area exists, is ACTIVE and belongs to the selected
 * city (normalised). Anything else is ignored (never trusted on its own). Null when not usable.
 */
export function findSelectableArea(
  areas: readonly ShippingArea[],
  areaId: unknown,
  city: unknown
): ShippingArea | null {
  const area = findAreaById(areas, areaId);
  if (!area || !isOn(area.active)) return null;
  const c = normaliseText(city);
  if (!c || normaliseText(area.city) !== c) return null;
  return area;
}

/** True when the (normalised) city has at least one ACTIVE area. */
export function cityHasActiveAreas(areas: readonly ShippingArea[], city: unknown): boolean {
  const c = normaliseText(city);
  if (!c) return false;
  return areas.some((a) => isOn(a.active) && normaliseText(a.city) === c);
}

/**
 * First zone id found walking the area, then its ancestors. Inactive areas are skipped (their zone_id
 * is not used). When `activeZoneIds` is given, a zone_id that is not in the set (inactive / deleted
 * zone) is skipped too. Null when nothing in the chain maps to a usable zone.
 */
export function resolveZoneIdFromArea(
  areas: readonly ShippingArea[],
  areaId: unknown,
  activeZoneIds?: ReadonlySet<number> | null
): number | null {
  for (const a of getAncestorChain(areas, areaId)) {
    if (!isOn(a.active)) continue;
    const zid = toId(a.zone_id);
    if (zid === null) continue;
    if (activeZoneIds && !activeZoneIds.has(zid)) continue;
    return zid;
  }
  return null;
}

/**
 * True when giving area `id` the parent `newParentId` would create a loop (the area is its own parent,
 * or the new parent is a descendant of the area). A null / unset parent never creates a cycle.
 */
export function wouldCreateParentCycle(
  areas: readonly ShippingArea[],
  id: unknown,
  newParentId: unknown
): boolean {
  const areaId = toId(id);
  const parentId = toId(newParentId);
  if (parentId === null) return false;
  if (areaId !== null && areaId === parentId) return true;
  if (areaId === null) return false;
  // Walk up from the proposed parent; reaching the area means the parent is its descendant.
  const seen = new Set<number>();
  let current = findAreaById(areas, parentId);
  while (current && seen.size < MAX_TREE_DEPTH) {
    const cid = Number(current.id);
    if (cid === areaId) return true;
    if (seen.has(cid)) return true; // pre-existing loop above the parent: refuse to extend it
    seen.add(cid);
    current = current.parent_id === null || current.parent_id === undefined
      ? null
      : findAreaById(areas, current.parent_id);
  }
  return false;
}

/** Uniqueness key: normalised city + parent id (or 0) + normalised name. */
export function normalisedAreaKey(city: unknown, parentId: unknown, name: unknown): string {
  return `${normaliseText(city)}|${toId(parentId) ?? 0}|${normaliseText(name)}`;
}

/**
 * Duplicate check used by the admin API (uniqueness is enforced in code, not by an index). Compares
 * normalised city + parent + name; `excludeId` lets an edit keep its own row. Returns the clashing area.
 */
export function findDuplicateArea(
  areas: readonly ShippingArea[],
  candidate: { city: unknown; parent_id?: unknown; name: unknown },
  excludeId?: unknown
): ShippingArea | null {
  const key = normalisedAreaKey(candidate.city, candidate.parent_id, candidate.name);
  if (key.endsWith("|")) return null; // empty name never matches
  const skip = toId(excludeId);
  for (const a of areas) {
    if (skip !== null && Number(a.id) === skip) continue;
    if (normalisedAreaKey(a.city, a.parent_id, a.name) === key) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const AREAS_CACHE_TTL_MS = 5_000;
let areasCache: { at: number; areas: ShippingArea[] } | null = null;

/** Test-only, and called by every admin area write so edits apply immediately. */
export function resetShippingAreasCache(): void {
  areasCache = null;
}

function mapAreaRow(row: RowDataPacket): ShippingArea {
  const parent = toId(row.parent_id);
  const zone = toId(row.zone_id);
  return {
    id: Number(row.id),
    city: String(row.city ?? ""),
    name: String(row.name ?? ""),
    parent_id: parent,
    zone_id: zone,
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order ?? 0),
  };
}

/** All areas (active and inactive), cached for a few seconds. Throws if the table is missing. */
export async function loadShippingAreas(db: Queryable): Promise<ShippingArea[]> {
  const now = Date.now();
  if (areasCache && now - areasCache.at < AREAS_CACHE_TTL_MS) return areasCache.areas;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, city, name, parent_id, zone_id, active, sort_order
     FROM shipping_areas ORDER BY sort_order ASC, id ASC`
  );
  const areas = (Array.isArray(rows) ? rows : []).map(mapAreaRow);
  areasCache = { at: now, areas };
  return areas;
}
