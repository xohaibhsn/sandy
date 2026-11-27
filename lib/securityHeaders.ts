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
