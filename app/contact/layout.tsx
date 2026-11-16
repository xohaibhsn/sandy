import type { Metadata } from "next";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `Contact Us — ${SITE_NAME}`,
  description: "Get in touch with S&Y. WhatsApp support, email, and contact form available. We reply within 24 hours.",
  alternates: { canonical: `${SITE_URL}/contact` },
  openGraph: { title: `Contact ${SITE_NAME}`, description: "WhatsApp, email and form support available.", url: `${SITE_URL}/contact`, siteName: SITE_NAME, type: "website" },
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return (
    <SiteContentProvider initialContent={map}>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "Contact", url: `${SITE_URL}/contact` },
        ]}
      />
      {children}
    </SiteContentProvider>
  );
}
