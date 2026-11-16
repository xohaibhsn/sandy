"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

type SiteContentMap = Record<string, string>;

const SiteContentCtx = createContext<SiteContentMap | null>(null);

function isAcceptableContentMap(data: unknown): data is SiteContentMap {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  // API error bodies like { error: "..." } must not replace CMS maps.
  if (Object.prototype.hasOwnProperty.call(obj, "error")) return false;
  return Object.values(obj).every((v) => typeof v === "string");
}

/**
 * Server-injected initial CMS map. On pathname change, refreshes via no-store
 * fetch so shared-parent soft-nav (blog/products list↔child) sees fresh values
 * without renaming large client pages. First paint uses initialContent (SSR/hydration match).
 */
export function SiteContentProvider({
  initialContent,
  children,
}: {
  initialContent: SiteContentMap;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [content, setContent] = useState<SiteContentMap>(initialContent);
  const [prevInitial, setPrevInitial] = useState<SiteContentMap>(initialContent);

  // When the server sends a new map (layout/page remount), adopt it during render.
  if (initialContent !== prevInitial) {
    setPrevInitial(initialContent);
    setContent(initialContent);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/site-content?page=all", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return null;
        const data = await r.json();
        return isAcceptableContentMap(data) ? data : null;
      })
      .then((data) => {
        if (!cancelled && data) setContent(data);
      })
      .catch(() => {
        /* keep prior map */
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <SiteContentCtx.Provider value={content}>{children}</SiteContentCtx.Provider>
  );
}

export function useSiteContentContext(): SiteContentMap | null {
  return useContext(SiteContentCtx);
}
