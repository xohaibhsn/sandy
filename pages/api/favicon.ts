import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { SITE_URL } from "@/lib/site";

const FALLBACK = `${SITE_URL}/og-default.svg`;

function isSelfFaviconPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/favicon.ico" || path === "/api/favicon";
}

/**
 * Resolve CMS favicon_url to a safe absolute http(s) redirect target.
 * Rejects self-referential /favicon.ico and /api/favicon (would loop via rewrite).
 */
function resolveFaviconRedirect(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return FALLBACK;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, SITE_URL);
  } catch {
    return FALLBACK;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return FALLBACK;
  }

  if (parsed.username || parsed.password) {
    return FALLBACK;
  }

  if (isSelfFaviconPath(parsed.pathname)) {
    return FALLBACK;
  }

  return parsed.toString();
}

/**
 * Browser default request target: /favicon.ico → rewritten here.
 * Always redirects to a validated CMS favicon_url or a real public fallback.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).end();
  }

  let faviconUrl = "";
  try {
    const [rows]: any = await pool.query(
      "SELECT content_value FROM site_content WHERE content_key='favicon_url' LIMIT 1"
    );
    faviconUrl = String(rows?.[0]?.content_value || "").trim().split("?")[0];
  } catch {
    /* ignore */
  }

  faviconUrl = resolveFaviconRedirect(faviconUrl);

  // Serve a small PNG via Cloudinary transforms when possible
  if (faviconUrl.includes("res.cloudinary.com") && faviconUrl.includes("/upload/")) {
    faviconUrl = faviconUrl.replace(
      "/upload/",
      "/upload/c_fit,w_48,h_48,f_png,q_auto/"
    );
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.redirect(302, faviconUrl);
}
