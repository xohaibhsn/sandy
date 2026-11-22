/**
 * Customer transactional-email flags loaded from site_content with short TTL cache.
 * Both default OFF when the key is absent or invalid. Writes gated by settings:accounts (super_admin).
 */
import type { RowDataPacket } from "mysql2";
import pool from "./db";

export const CUSTOMER_EMAIL_SETTINGS_KEYS = [
  "customer_email_received_enabled",
  "customer_email_confirmed_enabled",
] as const;

export type CustomerEmailSettingsKey = (typeof CUSTOMER_EMAIL_SETTINGS_KEYS)[number];

/** Raw flag map keyed by the site_content keys. */
export type CustomerEmailSettingsRaw = {
  customer_email_received_enabled: boolean;
  customer_email_confirmed_enabled: boolean;
};

/** Shape exposed to callers / the admin endpoint. */
export type CustomerEmailSettings = {
  received: boolean;
  confirmed: boolean;
};

export const CUSTOMER_EMAIL_SETTINGS_DEFAULTS: CustomerEmailSettingsRaw = {
  customer_email_received_enabled: false,
  customer_email_confirmed_enabled: false,
};

const CACHE_TTL_MS = 10_000;

let cache: { at: number; value: CustomerEmailSettings } | null = null;

/** Test-only: clear settings cache. */
export function resetCustomerEmailSettingsCache(): void {
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

export function parseCustomerEmailSettingsMap(
  map: Record<string, string | undefined | null>
): CustomerEmailSettingsRaw {
  const d = CUSTOMER_EMAIL_SETTINGS_DEFAULTS;
  return {
    customer_email_received_enabled: parseBool01(
      map.customer_email_received_enabled,
      d.customer_email_received_enabled
    ),
    customer_email_confirmed_enabled: parseBool01(
      map.customer_email_confirmed_enabled,
      d.customer_email_confirmed_enabled
    ),
  };
}

export function validateCustomerEmailSetting(
  key: string,
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const s = value === null || value === undefined ? "" : String(value).trim();
  switch (key) {
    case "customer_email_received_enabled":
    case "customer_email_confirmed_enabled":
      if (s !== "0" && s !== "1") return { ok: false, error: "Invalid flag (use 0 or 1)" };
      return { ok: true, value: s };
    default:
      return { ok: false, error: "Unknown setting" };
  }
}

export function isCustomerEmailSettingsContentKey(key: unknown): key is CustomerEmailSettingsKey {
  return CUSTOMER_EMAIL_SETTINGS_KEYS.includes(String(key ?? "") as CustomerEmailSettingsKey);
}

export async function loadCustomerEmailSettings(): Promise<CustomerEmailSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const map: Record<string, string> = {};
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT content_key, content_value FROM site_content
       WHERE content_key IN (${CUSTOMER_EMAIL_SETTINGS_KEYS.map(() => "?").join(",")})`,
      [...CUSTOMER_EMAIL_SETTINGS_KEYS]
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

  const raw = parseCustomerEmailSettingsMap(map);
  const value: CustomerEmailSettings = {
    received: raw.customer_email_received_enabled,
    confirmed: raw.customer_email_confirmed_enabled,
  };
  cache = { at: now, value };
  return value;
}
