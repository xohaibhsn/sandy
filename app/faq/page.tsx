import { connection } from "next/server";
import type { RowDataPacket } from "mysql2";
import pool, { isDatabaseConfigured } from "@/lib/db";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import JsonLd from "@/components/JsonLd";
import { SITE_URL } from "@/lib/site";
import FaqClient, { type FaqItem } from "./FaqClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type FaqRow = RowDataPacket & {
  id: number;
  question: string | null;
  answer: string | null;
  category: string | null;
  sort_order: number | null;
};

function serializeFaq(row: FaqRow): FaqItem | null {
  const question = String(row.question ?? "");
  const answer = String(row.answer ?? "");
  if (!question.trim() || !answer.trim()) return null;
  const category = String(row.category ?? "").trim();
  return {
    id: Number(row.id),
    question,
    answer,
    category: category || "General",
    sort_order: Number(row.sort_order) || 0,
  };
}

/**
 * Public FAQ list: visible rows, category then sort_order.
 * Read-only SELECT. Does not call ensureFaqsInitialized().
 */
async function listPublicFaqs(): Promise<FaqItem[]> {
  await connection();
  if (!isDatabaseConfigured()) return [];
  try {
    const [rows] = await pool.query<FaqRow[]>(
      `SELECT id, question, answer, category, sort_order
       FROM faqs
       WHERE is_visible = 1
       ORDER BY category, sort_order ASC`
    );
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const faq = serializeFaq(row);
      return faq ? [faq] : [];
    });
  } catch (err) {
    console.error("[faq] initial listing", err instanceof Error ? err.message : err);
    return [];
  }
}

function faqPageLd(faqs: FaqItem[]) {
  if (faqs.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

export default async function FAQPage() {
  const faqs = await listPublicFaqs();
  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "FAQ", url: `${SITE_URL}/faq` },
        ]}
      />
      <JsonLd data={faqPageLd(faqs)} />
      <FaqClient faqs={faqs} />
    </>
  );
}
