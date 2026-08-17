import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";
export const metadata: Metadata = {
  title: `Refund Policy — ${SITE_NAME}`,
  description: `${SITE_NAME} Refund & Return Policy. Full details on how to request a refund.`,
  openGraph: { title: `Refund Policy — ${SITE_NAME}`, url: `${SITE_URL}/refund-policy`, siteName: SITE_NAME, type: "website" },
};
export default function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }
