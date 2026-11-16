import { SiteContentProvider } from "@/hooks/SiteContentProvider";
import { getSiteContentMap } from "@/lib/siteContent";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CategoryLayout({ children }: { children: React.ReactNode }) {
  const map = await getSiteContentMap();
  return <SiteContentProvider initialContent={map}>{children}</SiteContentProvider>;
}
