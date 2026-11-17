/**
 * Deterministic category slug from display name.
 * lowercase → non-alphanumeric runs to `-` → trim edge `-`
 *
 * The `categories` table itself is created by migrations/0003-admin-schema.sql; the app never
 * creates or alters it at runtime.
 */
export function categorySlugFromName(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
