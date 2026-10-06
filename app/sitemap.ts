import type { MetadataRoute } from "next";
import pool, { isDatabaseConfigured } from "@/lib/db";
import { ensureCategoriesTable } from "@/lib/ensureCategories";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = SITE_URL;
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${baseUrl}/products`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${baseUrl}/blog`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${baseUrl}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/faq`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/privacy-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  let productPages: MetadataRoute.Sitemap = [];
  let blogPages: MetadataRoute.Sitemap = [];
  let categoryPages: MetadataRoute.Sitemap = [];

  if (isDatabaseConfigured()) {
    try {
      // Prefer stored slug column; fall back to name-derived slug for older rows
      const [products]: any = await pool.query(
        `SELECT
           COALESCE(
             NULLIF(slug, ''),
             LOWER(REPLACE(REPLACE(name, ' ', '-'), '/', ''))
           ) AS slug,
           created_at
         FROM products
         WHERE active = 1 AND name IS NOT NULL AND name != ''`
      );

      productPages = (Array.isArray(products) ? products : [])
        .filter((p: { slug?: string }) => !!p.slug)
        .map((p: { slug: string; created_at?: string | Date }) => ({
          url: `${baseUrl}/products/${p.slug}`,
          lastModified: p.created_at ? new Date(p.created_at) : now,
          changeFrequency: "weekly" as const,
          priority: 0.8,
        }));
    } catch {
      // Keep static pages if DB is unavailable
    }

    try {
      await ensureCategoriesTable();
      const [cats]: any = await pool.query(
        `SELECT slug, updated_at, created_at
         FROM categories
         WHERE active = 1 AND slug IS NOT NULL AND slug != ''`
      );
      categoryPages = (Array.isArray(cats) ? cats : [])
        .filter((c: { slug?: string }) => !!c.slug)
        .map((c: { slug: string; updated_at?: string | Date; created_at?: string | Date }) => ({
          url: `${baseUrl}/category/${c.slug}`,
          lastModified: c.updated_at
            ? new Date(c.updated_at)
            : c.created_at
              ? new Date(c.created_at)
              : now,
          changeFrequency: "weekly" as const,
          priority: 0.7,
        }));
    } catch {
      // Keep existing sitemap pages if categories query fails
    }

    try {
      const [posts]: any = await pool.query(
        `SELECT slug, created_at
         FROM blog_posts
         WHERE status = 'published' AND active = 1
           AND slug IS NOT NULL AND slug != ''`
      );

      blogPages = (Array.isArray(posts) ? posts : []).map(
        (p: { slug: string; created_at?: string | Date }) => ({
          url: `${baseUrl}/blog/${p.slug}`,
          lastModified: p.created_at ? new Date(p.created_at) : now,
          changeFrequency: "weekly" as const,
          priority: 0.7,
        })
      );
    } catch {
      // Keep static pages if DB is unavailable
    }
  }

  return [...staticPages, ...categoryPages, ...productPages, ...blogPages];
}
