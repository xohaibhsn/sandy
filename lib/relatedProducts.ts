import pool from "@/lib/db";
import { getPublicAvailability } from "@/lib/inventoryAvailability";

export type RelatedProductRow = {
  id: number;
  name: string;
  slug: string | null;
  price: number;
  image: string | null;
  category: string;
  badge: string | null;
  track_inventory?: number | string | null;
  stock_quantity?: number | string | null;
  created_at?: string | Date | null;
};

export type RelatedProductCard = {
  id: number;
  name: string;
  slug: string;
  price: number;
  image: string | null;
  badge: string | null;
  outOfStock: boolean;
};

export type RelatedSelectOpts = {
  count: number;
  fill: boolean;
};

function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 2;
  const n = Math.trunc(count);
  if (n < 2) return 2;
  if (n > 8) return 8;
  return n;
}

function newestKey(p: RelatedProductRow): number {
  if (p.created_at != null) {
    const t = new Date(p.created_at).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Number(p.id) || 0;
}

function hasSlug(p: RelatedProductRow): p is RelatedProductRow & { slug: string } {
  return typeof p.slug === "string" && p.slug.trim().length > 0;
}

function toCard(p: RelatedProductRow): RelatedProductCard | null {
  if (!hasSlug(p)) return null;
  const availability = getPublicAvailability(p);
  return {
    id: Number(p.id),
    name: String(p.name || ""),
    slug: String(p.slug).trim(),
    price: Number(p.price) || 0,
    image: p.image ? String(p.image) : null,
    badge: p.badge ? String(p.badge) : null,
    outOfStock: availability.label === "Out of stock",
  };
}

function sortRelated(a: RelatedProductRow, b: RelatedProductRow): number {
  const aAvail = getPublicAvailability(a).available ? 1 : 0;
  const bAvail = getPublicAvailability(b).available ? 1 : 0;
  if (aAvail !== bAvail) return bAvail - aAvail; // in-stock first
  const aNew = newestKey(a);
  const bNew = newestKey(b);
  if (aNew !== bNew) return bNew - aNew; // newest first
  return Number(b.id) - Number(a.id);
}

/**
 * Pure selector: same category first (excluding current), in-stock before OOS,
 * newest first; optionally fill with other categories. Never duplicates. Count clamped 2–8.
 */
export function selectRelatedProducts(
  current: { id: number; category?: string | null },
  candidates: RelatedProductRow[],
  opts: RelatedSelectOpts
): RelatedProductCard[] {
  const count = clampCount(opts.count);
  const currentId = Number(current.id);
  const category = String(current.category || "").trim();

  const poolList = (candidates || []).filter(
    (p) => p && Number(p.id) !== currentId && hasSlug(p)
  );

  const sameCat = poolList
    .filter((p) => String(p.category || "").trim() === category && category.length > 0)
    .slice()
    .sort(sortRelated);

  const selected: RelatedProductRow[] = [];
  const seen = new Set<number>();

  for (const p of sameCat) {
    if (selected.length >= count) break;
    const id = Number(p.id);
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(p);
  }

  if (opts.fill && selected.length < count) {
    const others = poolList
      .filter((p) => String(p.category || "").trim() !== category)
      .slice()
      .sort(sortRelated);
    for (const p of others) {
      if (selected.length >= count) break;
      const id = Number(p.id);
      if (seen.has(id)) continue;
      seen.add(id);
      selected.push(p);
    }
  }

  const cards: RelatedProductCard[] = [];
  for (const p of selected.slice(0, count)) {
    const card = toCard(p);
    if (card) cards.push(card);
  }
  return cards;
}

export type GetRelatedOpts = {
  count: number;
  fill: boolean;
};

/**
 * ONE bounded query then pure selector. Errors → [] so the product page never fails.
 */
export async function getRelatedProducts(
  current: { id: number; category?: string | null },
  opts: GetRelatedOpts
): Promise<RelatedProductCard[]> {
  try {
    const id = Number(current.id);
    if (!Number.isFinite(id) || id <= 0) return [];
    const [rows] = await pool.query(
      `SELECT id, name, slug, price, image, category, badge,
              track_inventory, stock_quantity, created_at
       FROM products
       WHERE (active = 1 OR active IS NULL) AND id <> ?
       ORDER BY id DESC
       LIMIT 60`,
      [id]
    );
    const candidates = Array.isArray(rows) ? (rows as RelatedProductRow[]) : [];
    return selectRelatedProducts(current, candidates, {
      count: opts.count,
      fill: opts.fill,
    });
  } catch {
    return [];
  }
}

export function parseRelatedCms(map: Record<string, string>): {
  enabled: boolean;
  title: string;
  count: number;
  fill: boolean;
} {
  const enabledRaw = String(map.product_related_enabled ?? "1").trim();
  const fillRaw = String(map.product_related_fill ?? "1").trim();
  const countRaw = Number(String(map.product_related_count ?? "4").trim());
  return {
    enabled: enabledRaw !== "0",
    title: String(map.product_related_title ?? "You may also like").trim() || "You may also like",
    count: clampCount(Number.isFinite(countRaw) ? countRaw : 4),
    fill: fillRaw !== "0",
  };
}
