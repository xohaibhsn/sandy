import type { Metadata } from "next";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `About Us — ${SITE_NAME}`,
  description: "S&Y is a Pakistani online store based in Lahore. Quality products, honest prices, and delivery you can rely on.",
  alternates: { canonical: `${SITE_URL}/about` },
  openGraph: { title: `About Us — ${SITE_NAME}`, description: "A Pakistani online store for accessories, gadgets and everyday products.", url: `${SITE_URL}/about`, siteName: SITE_NAME, type: "website" },
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return (
    <SiteContentProvider initialContent={map}>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "About", url: `${SITE_URL}/about` },
        ]}
      />
      {children}
    </SiteContentProvider>
  );
}
