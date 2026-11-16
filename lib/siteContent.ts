import { cache } from "react";
import pool, { isDatabaseConfigured } from "@/lib/db";

/**
 * Request-scoped site_content map (React cache() de-dupes within one render only).
 * Same shape as GET /api/site-content?page=all: all keys, value || ''.
 * Never throws; returns {} when DB is unconfigured or the query fails.
 */
export const getSiteContentMap = cache(async (): Promise<Record<string, string>> => {
  if (!isDatabaseConfigured()) return {};
  try {
    const queryResult = await pool.query(
      `SELECT content_key, content_value FROM site_content`
    );
    const rows = Array.isArray(queryResult) ? queryResult[0] : null;
    if (!Array.isArray(rows)) return {};
    const result: Record<string, string> = {};
    for (const row of rows as Array<{ content_key?: unknown; content_value?: unknown }>) {
      const key = String(row.content_key ?? "");
      if (!key) continue;
      result[key] = row.content_value == null ? "" : String(row.content_value);
    }
    return result;
  } catch {
    return {};
  }
});
