import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Products — ${SITE_NAME}`,
  description: "Browse accessories, gadgets and everyday products at S&Y. Quality items delivered across Pakistan.",
  alternates: { canonical: `${SITE_URL}/products` },
  openGraph: {
    title: `Products — ${SITE_NAME}`,
    description: "Browse accessories, gadgets and everyday products at S&Y. Quality items delivered across Pakistan.",
    url: `${SITE_URL}/products`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
