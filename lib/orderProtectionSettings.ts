/**
 * COD / order-protection settings loaded from site_content with short TTL cache.
 * Defaults applied in code when a key is absent. Writes gated by settings:order_protection.
 */
import type { RowDataPacket } from "mysql2";
import pool from "./db";

export const ORDER_PROTECTION_KEYS = [
  "cod_protection_enabled",
  "cod_otp_enabled",
  "cod_new_customer_cap",
  "cod_max_open_per_phone",
  "cod_risky_mode",
  "cod_advance_delivery_charge",
  "cod_risk_threshold",
  "advance_methods",
] as const;

export type OrderProtectionKey = (typeof ORDER_PROTECTION_KEYS)[number];

export type RiskyMode = "advance_only" | "advance_delivery_charge";
export type AdvanceMethod = "jazzcash" | "easypaisa" | "bank";

export type OrderProtectionSettings = {
  cod_protection_enabled: boolean;
  cod_otp_enabled: boolean;
  cod_new_customer_cap: number;
  cod_max_open_per_phone: number;
  cod_risky_mode: RiskyMode;
  cod_advance_delivery_charge: number;
  cod_risk_threshold: number;
  advance_methods: AdvanceMethod[];
};

export const ORDER_PROTECTION_DEFAULTS: OrderProtectionSettings = {
  cod_protection_enabled: false,
  cod_otp_enabled: false,
  cod_new_customer_cap: 5000,
  cod_max_open_per_phone: 1,
  cod_risky_mode: "advance_only",
  cod_advance_delivery_charge: 0,
  cod_risk_threshold: 50,
  advance_methods: ["jazzcash", "easypaisa", "bank"],
};

const ALL_ADVANCE: readonly AdvanceMethod[] = ["jazzcash", "easypaisa", "bank"];
const CACHE_TTL_MS = 10_000;

let cache: { at: number; value: OrderProtectionSettings } | null = null;

/** Test-only: clear settings cache. */
export function resetOrderProtectionSettingsCache(): void {
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

function parseNonNegInt(raw: unknown, fallback: number, max = 10_000_000): number {
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > max) return fallback;
  return n;
}

function parseRiskyMode(raw: unknown, fallback: RiskyMode): RiskyMode {
  const s = String(raw ?? "").trim();
  if (s === "advance_only" || s === "advance_delivery_charge") return s;
  return fallback;
}

function parseAdvanceMethods(raw: unknown, fallback: AdvanceMethod[]): AdvanceMethod[] {
  if (raw === null || raw === undefined) return [...fallback];
  const s = String(raw).trim();
  if (!s) return [...fallback];
  const parts = s.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const out: AdvanceMethod[] = [];
  for (const p of parts) {
    if ((ALL_ADVANCE as readonly string[]).includes(p) && !out.includes(p as AdvanceMethod)) {
      out.push(p as AdvanceMethod);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

export function parseOrderProtectionMap(
  map: Record<string, string | undefined | null>
): OrderProtectionSettings {
  const d = ORDER_PROTECTION_DEFAULTS;
  return {
    cod_protection_enabled: parseBool01(map.cod_protection_enabled, d.cod_protection_enabled),
    cod_otp_enabled: parseBool01(map.cod_otp_enabled, d.cod_otp_enabled),
    cod_new_customer_cap: parseNonNegInt(map.cod_new_customer_cap, d.cod_new_customer_cap),
    cod_max_open_per_phone: parseNonNegInt(map.cod_max_open_per_phone, d.cod_max_open_per_phone, 100),
    cod_risky_mode: parseRiskyMode(map.cod_risky_mode, d.cod_risky_mode),
    cod_advance_delivery_charge: parseNonNegInt(
      map.cod_advance_delivery_charge,
      d.cod_advance_delivery_charge
    ),
    cod_risk_threshold: parseNonNegInt(map.cod_risk_threshold, d.cod_risk_threshold, 100),
    advance_methods: parseAdvanceMethods(map.advance_methods, d.advance_methods),
  };
}

/**
 * Validate a site_content write for order-protection keys.
 * Returns canonical string value or throws ContentValidationError-compatible message.
 */
export function validateOrderProtectionSetting(
  key: string,
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const s = value === null || value === undefined ? "" : String(value).trim();
  switch (key) {
    case "cod_protection_enabled":
    case "cod_otp_enabled":
      if (s !== "0" && s !== "1") return { ok: false, error: "Invalid flag (use 0 or 1)" };
      return { ok: true, value: s };
    case "cod_new_customer_cap":
    case "cod_advance_delivery_charge": {
      if (!/^\d+$/.test(s)) return { ok: false, error: "Invalid amount" };
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { ok: false, error: "Invalid amount" };
      return { ok: true, value: String(n) };
    }
    case "cod_max_open_per_phone": {
      if (!/^\d+$/.test(s)) return { ok: false, error: "Invalid max open" };
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, error: "Invalid max open" };
      return { ok: true, value: String(n) };
    }
    case "cod_risk_threshold": {
      if (!/^\d+$/.test(s)) return { ok: false, error: "Invalid risk threshold" };
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, error: "Invalid risk threshold" };
      return { ok: true, value: String(n) };
    }
    case "cod_risky_mode":
      if (s !== "advance_only" && s !== "advance_delivery_charge") {
        return { ok: false, error: "Invalid risky mode" };
      }
      return { ok: true, value: s };
    case "advance_methods": {
      const methods = parseAdvanceMethods(s, []);
      if (methods.length === 0) return { ok: false, error: "Invalid advance methods" };
      // reject unknown tokens
      const tokens = s.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
      for (const t of tokens) {
        if (!(ALL_ADVANCE as readonly string[]).includes(t)) {
          return { ok: false, error: "Invalid advance methods" };
        }
      }
      return { ok: true, value: methods.join(",") };
    }
    default:
      return { ok: false, error: "Unknown setting" };
  }
}

export function isOrderProtectionContentKey(key: unknown): key is OrderProtectionKey {
  return ORDER_PROTECTION_KEYS.includes(String(key ?? "") as OrderProtectionKey);
}

export async function loadOrderProtectionSettings(): Promise<OrderProtectionSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const map: Record<string, string> = {};
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT content_key, content_value FROM site_content
       WHERE content_key IN (${ORDER_PROTECTION_KEYS.map(() => "?").join(",")})`,
      [...ORDER_PROTECTION_KEYS]
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const k = String(row.content_key || "");
        if (k) map[k] = String(row.content_value ?? "");
      }
    }
  } catch {
    // Missing table / DB blip → defaults (flags off).
  }

  const value = parseOrderProtectionMap(map);
  cache = { at: now, value };
  return value;
}
