import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";
export const metadata: Metadata = {
  title: `FAQ — ${SITE_NAME}`,
  description: "Find answers to common questions about ordering, delivery, payments and returns at S&Y.",
  alternates: { canonical: `${SITE_URL}/faq` },
  openGraph: { title: `FAQ — ${SITE_NAME}`, description: "Answers to common questions about ordering and delivery.", url: `${SITE_URL}/faq`, siteName: SITE_NAME, type: "website" },
};
export default function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }
