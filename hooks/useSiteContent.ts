"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSiteContentContext } from "@/hooks/SiteContentProvider";

type SiteContentMap = Record<string, string>;

/** Concurrent in-flight de-dupe only — never a process-lifetime/forever cache. */
let inflight: Promise<SiteContentMap> | null = null;

function normalizeMap(data: unknown): SiteContentMap {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as SiteContentMap;
  }
  return {};
}

export function loadSiteContent(): Promise<SiteContentMap> {
  if (!inflight) {
    inflight = fetch("/api/site-content?page=all", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => normalizeMap(data))
      .catch(() => ({}))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function cmsText(sc: SiteContentMap, key: string, fallback = ""): string {
  const value = String(sc[key] ?? "").trim();
  return value || fallback;
}

export function cmsFill(template: string, vars: Record<string, string>): string {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Prefer server-injected provider map (sync, hydration-safe).
 * Outside a provider (e.g. root WhatsAppButton, not-found): fetch no-store on
 * mount and whenever pathname changes. No process-lifetime singleton cache.
 */
export function useSiteContent(): SiteContentMap {
  const fromProvider = useSiteContentContext();
  const pathname = usePathname();
  const [data, setData] = useState<SiteContentMap>({});

  useEffect(() => {
    if (fromProvider !== null) return;
    let cancelled = false;
    loadSiteContent().then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fromProvider, pathname]);

  if (fromProvider !== null) return fromProvider;
  return data;
}
