/**
 * Cross-zone city/province overlap detection (SANDY-BATCH-14 / D41).
 *
 * Pure helpers used by admin-shipping-zones (create/update) and unit tests.
 * Matching keys use the same normalisation as quote-time matching (normaliseCity /
 * normaliseProvince / parseZoneList). Inactive zones do not block. The default-zone
 * exemption is "no cities and no provinces" — empty lists never conflict.
 * Existing overlaps on read/list are intentionally not rejected (write-only rule).
 */
import { normaliseCity, normaliseProvince, parseZoneList } from "./shippingNormalise";

export type OverlapZoneInput = {
  id: number;
  name: string;
  cities: string | string[] | null;
  provinces: string | string[] | null;
  active: boolean | number;
  is_default?: boolean | number;
};

export type OverlapConflict = {
  kind: "city" | "province";
  /** Display value from the submitted list (first matching entry). */
  value: string;
  /** Normalised key that collided. */
  key: string;
  otherZoneId: number;
  otherZoneName: string;
};

function isOn(v: unknown): boolean {
  return v === true || Number(v) === 1;
}

/**
 * Find the first city or province in `cities` / `provinces` that is already assigned
 * to a different ACTIVE zone. `excludeZoneId` is the zone being edited (self-exempt).
 * Submitted display strings are scanned in order; the first conflict wins.
 */
export function findZoneListOverlap(input: {
  cities: string | string[] | null | undefined;
  provinces: string | string[] | null | undefined;
  excludeZoneId?: number | null;
  otherZones: readonly OverlapZoneInput[];
}): OverlapConflict | null {
  const excludeId =
    input.excludeZoneId === undefined || input.excludeZoneId === null
      ? null
      : Number(input.excludeZoneId);

  const cityKeys = parseZoneList(input.cities);
  const provinceKeys = parseZoneList(input.provinces);
  if (!cityKeys.length && !provinceKeys.length) return null;

  const cityDisplay = displayMap(input.cities, normaliseCity);
  const provinceDisplay = displayMap(input.provinces, normaliseProvince);

  for (const z of input.otherZones) {
    if (!isOn(z.active)) continue;
    if (excludeId !== null && Number(z.id) === excludeId) continue;

    const otherCities = new Set(parseZoneList(z.cities));
    for (const key of cityKeys) {
      if (otherCities.has(key)) {
        return {
          kind: "city",
          value: cityDisplay.get(key) || key,
          key,
          otherZoneId: Number(z.id),
          otherZoneName: String(z.name || `zone #${z.id}`),
        };
      }
    }

    const otherProvinces = new Set(parseZoneList(z.provinces));
    for (const key of provinceKeys) {
      if (otherProvinces.has(key)) {
        return {
          kind: "province",
          value: provinceDisplay.get(key) || key,
          key,
          otherZoneId: Number(z.id),
          otherZoneName: String(z.name || `zone #${z.id}`),
        };
      }
    }
  }
  return null;
}

export function formatOverlapError(conflict: OverlapConflict): string {
  const label = conflict.kind === "city" ? "City" : "Province";
  return `${label} "${conflict.value}" is already assigned to zone "${conflict.otherZoneName}".`;
}

/** Preserve first trimmed display string per normalised key (same order as parseList). */
function displayMap(
  raw: string | string[] | null | undefined,
  normalise: (v: unknown) => string
): Map<string, string> {
  const map = new Map<string, string>();
  if (raw === null || raw === undefined) return map;
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\r\n,;|]+/);
  for (const p of parts) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (!t) continue;
    const key = normalise(t);
    if (!key || map.has(key)) continue;
    map.set(key, t);
  }
  return map;
}
