import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";
export const metadata: Metadata = {
  title: `Track Your Order — ${SITE_NAME}`,
  description: "Enter your Order ID to track your S&Y order in real time. Check payment, dispatch and delivery status.",
  openGraph: { title: `Track Your Order — ${SITE_NAME}`, description: "Real-time order tracking for S&Y customers.", url: `${SITE_URL}/order-tracking`, siteName: SITE_NAME, type: "website" },
};
export default function Layout({ children }: { children: React.ReactNode }) { return <>{children}</>; }
