import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  RedirectValidationError,
  getActiveRedirectBySource,
  isProtectedRedirectSource,
  normalizeRedirectSource,
  type RedirectStatusCode,
} from "./lib/redirects";
import {
  isLiveBlogSlug,
  isLiveProductSlug,
  parseBlogRedirectSlug,
  parseProductRedirectSlug,
} from "./lib/redirectRuntime";

const ALLOWED_REDIRECT_STATUSES = new Set<number>([301, 302, 307, 308]);

function passThrough(): NextResponse {
  return NextResponse.next();
}

function buildRedirectTarget(destination: string, requestUrl: string): URL | null {
  try {
    const dest = String(destination || "").trim();
    if (!dest) return null;

    if (/^https?:\/\//i.test(dest)) {
      return new URL(dest);
    }

    if (!dest.startsWith("/") || dest.startsWith("//")) {
      return null;
    }

    // Internal: current origin, discard inbound path/query; preserve stored query/fragment.
    return new URL(dest, requestUrl);
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return passThrough();
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeRedirectSource(request.nextUrl.pathname);
  } catch (err) {
    if (err instanceof RedirectValidationError) {
      return passThrough();
    }
    return passThrough();
  }

  if (isProtectedRedirectSource(normalizedPath)) {
    return passThrough();
  }

  let record;
  try {
    record = await getActiveRedirectBySource(normalizedPath);
  } catch {
    return passThrough();
  }

  if (!record) {
    return passThrough();
  }

  // Live entity wins over a stale redirect row (redirect-hit only).
  const productSlug = parseProductRedirectSlug(normalizedPath);
  if (productSlug) {
    try {
      if (await isLiveProductSlug(productSlug)) {
        return passThrough();
      }
    } catch {
      return passThrough();
    }
  }

  const blogSlug = parseBlogRedirectSlug(normalizedPath);
  if (blogSlug) {
    try {
      if (await isLiveBlogSlug(blogSlug)) {
        return passThrough();
      }
    } catch {
      return passThrough();
    }
  }

  const status = Number(record.status_code);
  if (!ALLOWED_REDIRECT_STATUSES.has(status)) {
    return passThrough();
  }

  const target = buildRedirectTarget(record.destination, request.url);
  if (!target) {
    return passThrough();
  }

  return NextResponse.redirect(target, status as RedirectStatusCode);
}

export const config = {
  matcher: [
    /*
     * Run Proxy on candidate public paths.
     * Exclude APIs, admin/CMS, framework assets, uploads/downloads, and common
     * static extensions. Keep .html / .htm / .php eligible for SEO redirects.
     */
    "/((?!api(?:/|$)|sidhu(?:/|$)|admin(?:/|$)|_next(?:/|$)|uploads(?:/|$)|downloads(?:/|$)|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:js|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$).*)",
  ],
};
