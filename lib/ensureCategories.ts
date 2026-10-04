import pool from "./db";

let ready = false;
let inFlight: Promise<void> | null = null;

/**
 * Deterministic category slug from display name.
 * lowercase → non-alphanumeric runs to `-` → trim edge `-`
 */
export function categorySlugFromName(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** @deprecated Use categorySlugFromName */
export const toCategorySlug = categorySlugFromName;

/**
 * Idempotent categories table ensure only.
 * Does NOT seed, backfill, or touch products.
 */
export async function ensureCategoriesTable(): Promise<void> {
  if (ready) return;
  if (!inFlight) {
    inFlight = ensureOnce().finally(() => {
      inFlight = null;
    });
  }
  await inFlight;
}

async function ensureOnce() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      description TEXT NULL,
      image VARCHAR(500) NULL,
      parent_id INT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_category_name (name),
      UNIQUE KEY unique_category_slug (slug),
      KEY idx_categories_active_sort (active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  ready = true;
}
