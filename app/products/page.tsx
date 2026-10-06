import { connection } from "next/server";
import type { RowDataPacket } from "mysql2";
import pool, { isDatabaseConfigured } from "@/lib/db";
import { parsePrice } from "@/lib/site";
import ProductsClient, { type Product } from "./ProductsClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ProductRow = RowDataPacket & {
  id: number;
  name: string | null;
  description: string | null;
  short_description: string | null;
  slug: string | null;
  price: number | string | null;
  badge: string | null;
  image: string | null;
  category: string | null;
  track_inventory: number | string | null;
  stock_quantity: number | string | null;
};

function serializeProduct(row: ProductRow): Product {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    description: row.description == null ? "" : String(row.description),
    short_description: row.short_description == null ? null : String(row.short_description),
    slug: row.slug ? String(row.slug) : null,
    price: parsePrice(row.price),
    badge: row.badge ? String(row.badge) : null,
    image: row.image ? String(row.image) : null,
    category: row.category == null ? "" : String(row.category),
    track_inventory: row.track_inventory ?? null,
    stock_quantity: row.stock_quantity ?? null,
  };
}

/**
 * Default public listing (featured = id ASC, active only).
 * Read-only SELECT. Does not call ensureProductsTable / ensureShopTables.
 */
async function listInitialProducts(): Promise<Product[] | null> {
  await connection();
  if (!isDatabaseConfigured()) return null;
  try {
    const [rows] = await pool.query<ProductRow[]>(
      `SELECT id, name, description, short_description, slug, price, badge, image, category,
              track_inventory, stock_quantity
       FROM products
       WHERE active = 1
       ORDER BY id ASC`
    );
    if (!Array.isArray(rows)) return [];
    return rows.map(serializeProduct);
  } catch (err) {
    console.error("[products] initial listing", err instanceof Error ? err.message : err);
    return null;
  }
}

export default async function ProductsPage() {
  const initialProducts = await listInitialProducts();
  return <ProductsClient initialProducts={initialProducts} />;
}
