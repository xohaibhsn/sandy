/**
 * Customer-accounts flag loaded from site_content with short TTL cache.
 * Default OFF when key absent. Writes gated by settings:accounts (super_admin).
 */
import type { RowDataPacket } from "mysql2";
import pool from "./db";

export const ACCOUNT_SETTINGS_KEYS = ["accounts_enabled"] as const;

export type AccountSettingsKey = (typeof ACCOUNT_SETTINGS_KEYS)[number];

export type AccountSettings = {
  accounts_enabled: boolean;
};

export const ACCOUNT_SETTINGS_DEFAULTS: AccountSettings = {
  accounts_enabled: false,
};

const CACHE_TTL_MS = 10_000;

let cache: { at: number; value: AccountSettings } | null = null;

/** Test-only: clear settings cache. */
export function resetAccountSettingsCache(): void {
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

export function parseAccountSettingsMap(
  map: Record<string, string | undefined | null>
): AccountSettings {
  const d = ACCOUNT_SETTINGS_DEFAULTS;
  return {
    accounts_enabled: parseBool01(map.accounts_enabled, d.accounts_enabled),
  };
}

export function validateAccountSetting(
  key: string,
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const s = value === null || value === undefined ? "" : String(value).trim();
  switch (key) {
    case "accounts_enabled":
      if (s !== "0" && s !== "1") return { ok: false, error: "Invalid flag (use 0 or 1)" };
      return { ok: true, value: s };
    default:
      return { ok: false, error: "Unknown setting" };
  }
}

export function isAccountSettingsContentKey(key: unknown): key is AccountSettingsKey {
  return ACCOUNT_SETTINGS_KEYS.includes(String(key ?? "") as AccountSettingsKey);
}

export async function loadAccountSettings(): Promise<AccountSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const map: Record<string, string> = {};
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT content_key, content_value FROM site_content
       WHERE content_key IN (${ACCOUNT_SETTINGS_KEYS.map(() => "?").join(",")})`,
      [...ACCOUNT_SETTINGS_KEYS]
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const k = String(row.content_key || "");
        if (k) map[k] = String(row.content_value ?? "");
      }
    }
  } catch {
    // Missing table / DB blip → defaults (flag off).
  }

  const value = parseAccountSettingsMap(map);
  cache = { at: now, value };
  return value;
}
