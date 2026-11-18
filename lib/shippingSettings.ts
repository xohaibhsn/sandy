/**
 * Shipping feature flag loaded from site_content with a short TTL cache (SANDY-BATCH-12).
 * Default OFF when the key is absent. Writes are gated by settings:shipping (super_admin).
 *
 * Saving shipping_enabled = 1 additionally requires exactly one ACTIVE default zone; that is a
 * database check, so pages/api/site-content.ts runs it (see countActiveDefaultZones in lib/shipping.ts)
 * after the pure value check below.
 */
import type { RowDataPacket } from "mysql2";
import pool from "./db";

export const SHIPPING_SETTINGS_KEYS = ["shipping_enabled"] as const;

export type ShippingSettingsKey = (typeof SHIPPING_SETTINGS_KEYS)[number];

export type ShippingSettings = {
  shipping_enabled: boolean;
};

export const SHIPPING_SETTINGS_DEFAULTS: ShippingSettings = {
  shipping_enabled: false,
};

const CACHE_TTL_MS = 10_000;

let cache: { at: number; value: ShippingSettings } | null = null;

/** Test-only (and called after every site_content write): clear settings cache. */
export function resetShippingSettingsCache(): void {
  cache = null;
}

function parseBool01(raw: unknown, fallback: boolean): boolean {
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim();
  if (s === "") return fallback;
  if (s === "1") return true;
  if (s === "0") return false;
  return fallback;
}

export function parseShippingSettingsMap(
  map: Record<string, string | undefined | null>
): ShippingSettings {
  const d = SHIPPING_SETTINGS_DEFAULTS;
  return {
    shipping_enabled: parseBool01(map.shipping_enabled, d.shipping_enabled),
  };
}

export function isShippingSettingsContentKey(key: unknown): key is ShippingSettingsKey {
  return SHIPPING_SETTINGS_KEYS.includes(String(key ?? "") as ShippingSettingsKey);
}

/**
 * Pure value check for the shipping_enabled write ("0" / "1" only). The readiness rule
 * (exactly one active default zone before "1") is enforced by the caller, which has DB access.
 */
export function validateShippingEnabledValue(
  value: unknown
): { ok: true; value: "0" | "1" } | { ok: false; error: string } {
  const s = value === null || value === undefined ? "" : String(value).trim();
  if (s !== "0" && s !== "1") return { ok: false, error: "Invalid flag (use 0 or 1)" };
  return { ok: true, value: s };
}

export function validateShippingSetting(
  key: string,
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  switch (key) {
    case "shipping_enabled":
      return validateShippingEnabledValue(value);
    default:
      return { ok: false, error: "Unknown setting" };
  }
}

/** User-facing error when enabling shipping without exactly one active default zone. */
export const SHIPPING_NEEDS_DEFAULT_ZONE_MESSAGE =
  "Shipping can only be enabled when exactly one active default zone exists";

export async function loadShippingSettings(): Promise<ShippingSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const map: Record<string, string> = {};
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT content_key, content_value FROM site_content
       WHERE content_key IN (${SHIPPING_SETTINGS_KEYS.map(() => "?").join(",")})`,
      [...SHIPPING_SETTINGS_KEYS]
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const k = String(row.content_key || "");
        if (k) map[k] = String(row.content_value ?? "");
      }
    }
  } catch {
    // Missing table / DB blip → default (flag off).
  }

  const value = parseShippingSettingsMap(map);
  cache = { at: now, value };
  return value;
}
