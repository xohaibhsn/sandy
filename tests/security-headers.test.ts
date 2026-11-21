/**
 * HARDEN-01: exported security header list assertions (no network).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { securityHeaders, CONTENT_SECURITY_POLICY } = await import(
  "../lib/securityHeaders.ts"
);

function header(key: string): string {
  const h = securityHeaders.find((x) => x.key === key);
  assert.ok(h, `missing header ${key}`);
  return h!.value;
}

describe("security headers (HARDEN-01)", () => {
  it("keeps pre-existing header values and Cache-Control", () => {
    assert.equal(header("X-Content-Type-Options"), "nosniff");
    assert.equal(header("X-Frame-Options"), "DENY");
    assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.equal(
      header("Permissions-Policy"),
      "camera=(), microphone=(), geolocation=()"
    );
    assert.equal(header("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("sets X-XSS-Protection to 0 (OWASP)", () => {
    assert.equal(header("X-XSS-Protection"), "0");
  });

  it("adds staged HSTS max-age=86400 without includeSubDomains/preload", () => {
    const hsts = header("Strict-Transport-Security");
    assert.equal(hsts, "max-age=86400");
    assert.ok(!/includeSubDomains/i.test(hsts));
    assert.ok(!/preload/i.test(hsts));
  });

  it("keeps every pre-existing CSP directive verbatim and appends new ones", () => {
    const csp = header("Content-Security-Policy");
    assert.equal(csp, CONTENT_SECURITY_POLICY);
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(
      csp.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    );
    assert.ok(
      csp.includes(
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
      )
    );
    assert.ok(csp.includes("font-src 'self' https://fonts.gstatic.com"));
    assert.ok(csp.includes("img-src 'self' data: blob: https:"));
    assert.ok(csp.includes("connect-src 'self' https:"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("base-uri 'self'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("form-action 'self'"));
  });
});
