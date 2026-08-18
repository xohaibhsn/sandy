import type { Metadata } from "next";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `About Us — ${SITE_NAME}`,
  description: "S&Y is a Pakistani online store based in Lahore. Quality products, honest prices, and delivery you can rely on.",
  alternates: { canonical: `${SITE_URL}/about` },
  openGraph: { title: `About Us — ${SITE_NAME}`, description: "A Pakistani online store for accessories, gadgets and everyday products.", url: `${SITE_URL}/about`, siteName: SITE_NAME, type: "website" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "About", url: `${SITE_URL}/about` },
        ]}
      />
      {children}
    </>
  );
}
