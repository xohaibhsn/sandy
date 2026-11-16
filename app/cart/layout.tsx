import type { Metadata } from "next";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `Cart & Checkout — ${SITE_NAME}`,
  description: "Complete your order at S&Y. Cash on Delivery, JazzCash, Easypaisa or bank transfer.",
  robots: { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/cart` },
  openGraph: {
    title: `Cart & Checkout — ${SITE_NAME}`,
    description: "Complete your order at S&Y. Cash on Delivery, JazzCash, Easypaisa or bank transfer.",
    url: `${SITE_URL}/cart`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default async function CartLayout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return <SiteContentProvider initialContent={map}>{children}</SiteContentProvider>;
}
