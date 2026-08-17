import type { Metadata } from "next";
import ProductDetail from "./ProductDetail";
import pool from "../../../lib/db";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import JsonLd from "@/components/JsonLd";
import { CURRENCY_CODE, SITE_NAME, SITE_URL } from "@/lib/site";

interface Product {
  id: number; name: string; description: string;
  price: number; badge: string | null; image: string | null; category: string; stock: string;
  short_description: string | null; full_description: string | null;
  features: string | null; seo_title: string | null; meta_description: string | null;
  focus_keyword: string | null; og_image: string | null; slug: string | null;
}

async function getProduct(slug: string): Promise<Product | null> {
  try {
    const s = slug.toLowerCase();
    const [rows]: any = await pool.query(
      `SELECT * FROM products
       WHERE active = 1 AND (
         slug = ?
         OR LOWER(REPLACE(REPLACE(name, ' ', '-'), '/', '')) = ?
       )
       LIMIT 1`,
      [s, s]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: `Product Not Found | ${SITE_NAME}` };

  const title = `${product.seo_title || product.name} | ${SITE_NAME}`;
  const rawDescription =
    product.meta_description || product.short_description || product.description || "";
  const description = stripHtml(rawDescription);
  const image = product.og_image || product.image || "";

  return {
    title,
    description,
    keywords: product.focus_keyword || "",
    alternates: {
      canonical: `${SITE_URL}/products/${slug}`,
    },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/products/${slug}`,
      siteName: SITE_NAME,
      type: "website",
      images: image ? [{ url: image, width: 1200, height: 630, alt: product.name }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: image ? [image] : [],
    },
  };
}

export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  const productUrl = `${SITE_URL}/products/${slug}`;

  const productLd = product
    ? {
        "@context": "https://schema.org",
        "@type": "Product",
        name: product.name,
        description: stripHtml(
          product.short_description || product.description || product.full_description || ""
        ),
        image: product.image || product.og_image || "",
        brand: {
          "@type": "Brand",
          name: SITE_NAME,
        },
        offers: {
          "@type": "Offer",
          price: String(Number(product.price).toFixed(2)),
          priceCurrency: CURRENCY_CODE,
          availability: "https://schema.org/InStock",
          url: productUrl,
          seller: {
            "@type": "Organization",
            name: SITE_NAME,
          },
        },
      }
    : null;

  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "Products", url: `${SITE_URL}/products` },
          { name: product?.name || slug, url: productUrl },
        ]}
      />
      <JsonLd data={productLd} />
      <ProductDetail slug={slug} initialProduct={product as any} />
    </>
  );
}
