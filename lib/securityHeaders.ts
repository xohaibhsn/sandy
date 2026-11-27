/**
 * HTTP security headers applied site-wide via next.config.ts `headers()`.
 * Pure data module so unit tests can assert values without loading Next config.
 */

export type SecurityHeader = { key: string; value: string };

/** Existing CSP directives (byte-stable) plus HARDEN-01 appendages. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self';";

export const securityHeaders: SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "0" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
  // HSTS 180 days (D57, raised 2026-11-28 after 7-day staging); NO includeSubDomains; NO preload.
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
];

/** Content-hashed Next build assets (/_next/static/*). */
export const STATIC_ASSET_CACHE = "public, max-age=31536000, immutable";

/** Public image/font files at site root and subfolders. */
export const PUBLIC_FILE_CACHE = "public, max-age=86400";

/**
 * Next.js `headers()` source for public static files by extension.
 * Verified with next/dist/compiled/path-to-regexp: matches
 * /og-default.jpg, /uploads/x.webp, /favicon.ico, /fonts/a.woff2;
 * does NOT match /api/products, /api/favicon, /products/phone-case, /_next/data/x.json.
 */
export const PUBLIC_FILE_SOURCE =
  "/:path*.(png|jpg|jpeg|webp|avif|gif|svg|ico|woff|woff2)";

export type HeaderRule = {
  source: string;
  headers: SecurityHeader[];
};

/**
 * Ordered header rules for next.config.ts. Next.js: last matching rule wins
 * for the same header key, so Cache-Control overrides come AFTER the catch-all
 * that also sets security headers (HSTS/CSP/XFO/nosniff stay from rule 1).
 */
export function buildHeaderRules(): HeaderRule[] {
  return [
    {
      source: "/(.*)",
      headers: securityHeaders,
    },
    {
      source: "/_next/static/:path*",
      headers: [{ key: "Cache-Control", value: STATIC_ASSET_CACHE }],
    },
    {
      source: PUBLIC_FILE_SOURCE,
      headers: [{ key: "Cache-Control", value: PUBLIC_FILE_CACHE }],
    },
    {
      source: "/_next/image",
      headers: [{ key: "Cache-Control", value: PUBLIC_FILE_CACHE }],
    },
  ];
}
