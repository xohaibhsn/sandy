import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Cart & Checkout — ${SITE_NAME}`,
  description: "Complete your order at S&Y. Cash on Delivery, JazzCash, Easypaisa or bank transfer.",
  openGraph: {
    title: `Cart & Checkout — ${SITE_NAME}`,
    description: "Complete your order at S&Y. Cash on Delivery, JazzCash, Easypaisa or bank transfer.",
    url: `${SITE_URL}/cart`,
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
