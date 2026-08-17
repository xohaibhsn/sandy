import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";
export const metadata: Metadata = {
  title: `Privacy Policy — ${SITE_NAME}`,
  description: `${SITE_NAME} Privacy Policy. Learn how we collect, use, and protect your personal data.`,
  openGraph: { title: `Privacy Policy — ${SITE_NAME}`, url: `${SITE_URL}/privacy-policy`, siteName: SITE_NAME, type: "website" },
};
export default function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }
