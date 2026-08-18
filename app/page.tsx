import type { Metadata } from "next";
import { connection } from "next/server";
import pool, { isDatabaseConfigured } from "@/lib/db";
import HomeClient from "./HomeClient";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getHomeContent(): Promise<Record<string, string>> {
  await connection();
  if (!isDatabaseConfigured()) return {};
  try {
    const [rows]: any = await pool.query(
      `SELECT content_key, content_value
       FROM site_content
       WHERE page_name = 'home'
          OR content_key IN (
            'home_meta_title',
            'home_meta_description',
            'home_top_hero_title',
            'home_top_hero_subtitle',
            'home_hero_title',
            'home_hero_subtitle',
            'home_tagline'
          )`
    );
    const result: Record<string, string> = {};
    for (const r of rows) result[r.content_key] = r.content_value || "";
    return result;
  } catch {
    return {};
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const content = await getHomeContent();
  const metaTitle =
    content.home_meta_title?.trim() ||
    `${SITE_NAME} — Quality products, delivered across Pakistan`;
  const metaDesc =
    content.home_meta_description?.trim() ||
    "Handpicked quality, authentic products, fast delivery. Shop accessories, gadgets and everyday essentials at S&Y.";

  return {
    title: { absolute: metaTitle },
    description: metaDesc,
    alternates: {
      canonical: SITE_URL,
    },
    openGraph: {
      title: metaTitle,
      description: metaDesc,
      url: SITE_URL,
      siteName: SITE_NAME,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: metaTitle,
      description: metaDesc,
    },
  };
}

export default async function HomePage() {
  const content = await getHomeContent();

  return (
    <>
      <BreadcrumbSchema
        items={[{ name: "Home", url: SITE_URL }]}
      />
      <HomeClient
        topHeroTitle={
          content.home_top_hero_title?.trim() || "S&Y — Quality products, delivered across Pakistan"
        }
        topHeroSubtitle={
          content.home_top_hero_subtitle?.trim() ||
          "Handpicked quality, authentic products, fast delivery."
        }
        heroTitle={
          content.home_hero_title?.trim() || "Quality products, delivered across Pakistan"
        }
        heroSubtitle={
          content.home_hero_subtitle?.trim() ||
          "S&Y is your Pakistani online store for accessories, gadgets and everyday essentials."
        }
      />
    </>
  );
}
