/**
 * CACHE-01: header rule order and public-file pattern boundaries.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const {
  buildHeaderRules,
  STATIC_ASSET_CACHE,
  PUBLIC_FILE_CACHE,
  PUBLIC_FILE_SOURCE,
  securityHeaders,
} = await import("../lib/securityHeaders.ts");

const require = createRequire(import.meta.url);
const { match } = require("next/dist/compiled/path-to-regexp") as {
  match: (
    path: string,
    opts?: { decode?: (s: string) => string }
  ) => (pathname: string) => false | { path: string; params: unknown };
};

describe("cache headers (CACHE-01)", () => {
  it("buildHeaderRules: catch-all first, then static, then public, then image", () => {
    const rules = buildHeaderRules();
    assert.ok(rules.length >= 3);
    assert.equal(rules[0].source, "/(.*)");
    assert.equal(rules[0].headers, securityHeaders);
    const cc0 = rules[0].headers.find((h) => h.key === "Cache-Control");
    assert.equal(cc0?.value, "no-store, no-cache, must-revalidate");

    assert.equal(rules[1].source, "/_next/static/:path*");
    assert.equal(rules[1].headers[0].key, "Cache-Control");
    assert.equal(rules[1].headers[0].value, STATIC_ASSET_CACHE);
    assert.equal(STATIC_ASSET_CACHE, "public, max-age=31536000, immutable");

    assert.equal(rules[2].source, PUBLIC_FILE_SOURCE);
    assert.equal(rules[2].headers[0].value, PUBLIC_FILE_CACHE);
    assert.equal(PUBLIC_FILE_CACHE, "public, max-age=86400");

    const imageRule = rules.find((r) => r.source === "/_next/image");
    assert.ok(imageRule);
    assert.equal(imageRule!.headers[0].value, PUBLIC_FILE_CACHE);
  });

  it("PUBLIC_FILE_SOURCE matches public images/fonts and not api/html/data", () => {
    const m = match(PUBLIC_FILE_SOURCE, { decode: decodeURIComponent });
    const yes = [
      "/og-default.jpg",
      "/uploads/x.webp",
      "/favicon.ico",
      "/fonts/a.woff2",
    ];
    const no = [
      "/api/products",
      "/api/favicon",
      "/products/phone-case",
      "/_next/data/x.json",
    ];
    for (const p of yes) {
      assert.ok(m(p), `expected match: ${p}`);
    }
    for (const p of no) {
      assert.equal(m(p), false, `expected no match: ${p}`);
    }
  });
});
