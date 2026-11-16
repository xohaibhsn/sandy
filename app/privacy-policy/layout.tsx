import type { Metadata } from "next";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `Privacy Policy — ${SITE_NAME}`,
  description: `${SITE_NAME} Privacy Policy. Learn how we collect, use, and protect your personal data.`,
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/privacy-policy` },
  openGraph: {
    title: `Privacy Policy — ${SITE_NAME}`,
    url: `${SITE_URL}/privacy-policy`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return <SiteContentProvider initialContent={map}>{children}</SiteContentProvider>;
}
