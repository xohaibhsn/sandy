import type { Metadata } from "next";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `Blog — ${SITE_NAME}`,
  description: "Guides, tips and news from S&Y — your Pakistani online store.",
  alternates: { canonical: `${SITE_URL}/blog` },
  openGraph: {
    title: `Blog — ${SITE_NAME}`,
    description: "Guides, tips and news from S&Y — your Pakistani online store.",
    url: `${SITE_URL}/blog`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default async function BlogLayout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return <SiteContentProvider initialContent={map}>{children}</SiteContentProvider>;
}
