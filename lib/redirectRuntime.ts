import pool from "./db";

/**
 * Exact /products/{single-segment} shape after source normalization.
 */
export function parseProductRedirectSlug(normalizedPath: string): string | null {
  const m = /^\/products\/([^/]+)$/.exec(normalizedPath);
  return m?.[1] || null;
}

/**
 * Exact /blog/{single-segment} shape after source normalization.
 */
export function parseBlogRedirectSlug(normalizedPath: string): string | null {
  const m = /^\/blog\/([^/]+)$/.exec(normalizedPath);
  return m?.[1] || null;
}

/**
 * Exact /category/{single-segment} shape after source normalization.
 */
export function parseCategoryRedirectSlug(normalizedPath: string): string | null {
  const m = /^\/category\/([^/]+)$/.exec(normalizedPath);
  return m?.[1] || null;
}

/**
 * Live/resolvable product existence matching CURRENT TRACKED
 * app/products/[slug] semantics: slug OR legacy name-derived slug,
 * AND active=1 (inactive products are not public / not live).
 * Throws on DB failure so Proxy can fail-open.
 */
export async function isLiveProductSlug(slug: string): Promise<boolean> {
  const s = String(slug || "").toLowerCase();
  if (!s) return false;
  const [rows] = await pool.query(
    `SELECT 1 AS ok
     FROM products
     WHERE active = 1
       AND (
         slug = ?
         OR LOWER(REPLACE(REPLACE(name, ' ', '-'), '/', '')) = ?
       )
     LIMIT 1`,
    [s, s]
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Live published blog post matching app/blog/[slug] semantics.
 * Throws on DB failure so Proxy can fail-open.
 */
export async function isLiveBlogSlug(slug: string): Promise<boolean> {
  const s = String(slug || "");
  if (!s) return false;
  const [rows] = await pool.query(
    `SELECT 1 AS ok
     FROM blog_posts
     WHERE slug = ?
       AND status = "published"
       AND active = 1
     LIMIT 1`,
    [s]
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Live/active category matching app/category/[slug] semantics.
 * Throws on DB failure so Proxy can fail-open.
 */
export async function isLiveCategorySlug(slug: string): Promise<boolean> {
  const s = String(slug || "");
  if (!s) return false;
  const [rows] = await pool.query(
    `SELECT 1 AS ok
     FROM categories
     WHERE slug = ?
       AND active = 1
     LIMIT 1`,
    [s]
  );
  return Array.isArray(rows) && rows.length > 0;
}
