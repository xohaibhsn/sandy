import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";
import { SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: `Your Account — ${SITE_NAME}`,
  robots: { index: false, follow: false },
};

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  // Feature flag (default off): account routes do not exist unless explicitly enabled.
  if (map.accounts_enabled !== "1") notFound();
  return <SiteContentProvider initialContent={map}>{children}</SiteContentProvider>;
}
