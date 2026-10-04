import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { RowDataPacket } from "mysql2";
import pool, { isDatabaseConfigured } from "@/lib/db";
import { ensureCategoriesTable } from "@/lib/ensureCategories";
import { ensureProductsTable } from "@/lib/ensureShopTables";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import CategoryClient from "./CategoryClient";

type CategoryRow = RowDataPacket & {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
};

type ProductRow = RowDataPacket & {
  id: number;
  name: string;
  slug: string | null;
  price: number;
  image: string | null;
  category: string;
  short_description: string | null;
  description: string | null;
  badge: string | null;
};

async function getActiveCategory(slug: string): Promise<CategoryRow | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureCategoriesTable();
    const [rows] = await pool.query<CategoryRow[]>(
      `SELECT id, name, slug, description, image
       FROM categories
       WHERE slug = ? AND active = 1
       LIMIT 1`,
      [slug]
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

async function getCategoryProducts(categoryName: string): Promise<ProductRow[]> {
  try {
    await ensureProductsTable();
    const [rows] = await pool.query<ProductRow[]>(
      `SELECT id, name, slug, price, image, category, short_description, description, badge
       FROM products
       WHERE active = 1 AND category = ?
       ORDER BY id DESC`,
      [categoryName]
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const category = await getActiveCategory(slug);
  if (!category) {
    return { title: `Category Not Found | ${SITE_NAME}` };
  }

  const title = `${category.name} | ${SITE_NAME}`;
  const description =
    (category.description || "").trim() ||
    `Shop ${category.name} at ${SITE_NAME}. Quality products delivered across Pakistan.`;
  const url = `${SITE_URL}/category/${category.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
    },
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const category = await getActiveCategory(slug);
  if (!category) notFound();

  const products = await getCategoryProducts(category.name);
  const url = `${SITE_URL}/category/${category.slug}`;

  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "Products", url: `${SITE_URL}/products` },
          { name: category.name, url },
        ]}
      />
      <CategoryClient category={category} initialProducts={products} />
    </>
  );
}
