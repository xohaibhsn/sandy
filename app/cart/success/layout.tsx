import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Order Confirmed — ${SITE_NAME}`,
  description: "Your order has been placed.",
  robots: { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/cart/success` },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
