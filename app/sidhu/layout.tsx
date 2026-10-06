import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/sidhu` },
};

export default function SidhuLayout({ children }: { children: React.ReactNode }) {
  return children;
}
