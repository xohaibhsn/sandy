import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Terms & Conditions — ${SITE_NAME}`,
  description: `Read the Terms & Conditions for ${SITE_NAME}. Covers orders, payments, refunds, and your rights as a customer in Pakistan.`,
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/terms` },
  openGraph: {
    title: `Terms & Conditions — ${SITE_NAME}`,
    url: `${SITE_URL}/terms`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
