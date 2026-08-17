"use client";

import { useEffect, useState } from "react";

let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;
const listeners = new Set<(data: Record<string, string>) => void>();

function loadSiteContent(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/site-content?page=all")
      .then((r) => r.json())
      .then((data) => {
        const next = data && typeof data === "object" && !Array.isArray(data) ? data : {};
        cache = next;
        listeners.forEach((fn) => fn(next));
        return next;
      })
      .catch(() => cache || {})
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function cmsText(sc: Record<string, string>, key: string, fallback = ""): string {
  const value = String(sc[key] ?? "").trim();
  return value || fallback;
}

/** Shared site_content fetch — one network request for Navbar, footer, contact, pages. */
export function useSiteContent(): Record<string, string> {
  const [data, setData] = useState<Record<string, string>>(cache || {});

  useEffect(() => {
    if (cache) {
      setData(cache);
      return;
    }
    const onUpdate = (next: Record<string, string>) => setData(next);
    listeners.add(onUpdate);
    loadSiteContent().then((next) => setData(next));
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);

  return data;
}
