/**
 * Pure city/province normalisation shared by quote matching, zone API parseList,
 * overlap detection, and the admin multi-select (client-safe — no DB imports).
 *
 * Rule: NFKC → lowercase → strip non letter/digit/space → collapse whitespace → trim.
 * Aliases (e.g. Rawalpindi/Pindi) are NOT handled here — follow-up only.
 */

/** trim, lowercase, strip punctuation (letters/digits/space only), collapse whitespace. */
export function normaliseText(value: unknown): string {
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
