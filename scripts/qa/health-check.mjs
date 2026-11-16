#!/usr/bin/env node
/**
 * sandy-qa health-check — read-only site health probe (F9).
 * GET only. No cookies, no auth headers, no write endpoints.
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const UA = "sandy-qa/1.0 (+read-only)";
const DEFAULT_BASE = "https://sandy.com.pk";
const TIMEOUT_MS = 15_000;
const MIN_GAP_MS = 300;
const MAX_REQUESTS = 25;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** @type {number} */
let requestCount = 0;
/** @type {number} */
let lastRequestAt = 0;

function usage(code = EXIT_USAGE) {
  const text = `Usage: node scripts/qa/health-check.mjs [--base <url>] [--json <file>] [--self-test]

Read-only health checks against the public site (default ${DEFAULT_BASE}).
GET only, max ${MAX_REQUESTS} requests, ${TIMEOUT_MS}ms timeout, >=${MIN_GAP_MS}ms between requests.
Exit: 0=pass, 1=check failed, 2=usage/runtime error.`;
  console.error(text);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, json: null, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (!v) usage();
      out.base = v.replace(/\/$/, "");
    } else if (a === "--json") {
      const v = argv[++i];
      if (!v) usage();
      out.json = v;
    } else usage();
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimit() {
  const elapsed = performance.now() - lastRequestAt;
  if (lastRequestAt && elapsed < MIN_GAP_MS) {
    await sleep(MIN_GAP_MS - elapsed);
  }
}

/**
 * @param {string} url
 * @param {{ accept?: string }} [opts]
 */
async function httpGet(url, opts = {}) {
  if (requestCount >= MAX_REQUESTS) {
    throw new Error(`Request budget exceeded (${MAX_REQUESTS})`);
  }
  await rateLimit();
  requestCount += 1;
  lastRequestAt = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: opts.accept || "*/*",
      },
    });
    const ms = Math.round(performance.now() - t0);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return {
      status: res.status,
      ms,
      text,
      headers: res.headers,
      finalUrl: url,
      redirected: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow redirects for page GETs (still GET-only, same-origin host only).
 * @param {string} url
 * @param {string} baseOrigin
 * @param {number} [maxHops]
 */
async function httpGetFollow(url, baseOrigin, maxHops = 5) {
  let current = url;
  let hops = 0;
  /** @type {Awaited<ReturnType<typeof httpGet>> | null} */
  let last = null;
  while (hops <= maxHops) {
    last = await httpGet(current);
    if (last.status >= 300 && last.status < 400) {
      const loc = last.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current);
      if (next.origin !== baseOrigin) {
        throw new Error(`Refusing external redirect to ${next.origin}`);
      }
      current = next.href;
      hops += 1;
      continue;
    }
    return { ...last, finalUrl: current, redirected: hops > 0 };
  }
  return { ...last, finalUrl: current, redirected: hops > 0 };
}

function countTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  return (html.match(re) || []).length;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    locs.push(m[1].trim());
  }
  return locs;
}

function sanitiseExtract(s, max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Order-payload markers that must NOT appear in unauthenticated /sidhu HTML. */
function orderDataMarkers() {
  return [
    "customer_email",
    "customer_phone",
    "customer_name",
    "items_list",
    '"order_id"',
    "reversed_amount",
  ];
}

function findOrderMarkers(html) {
  const hits = [];
  for (const marker of orderDataMarkers()) {
    if (html.includes(marker)) hits.push(marker);
  }
  return hits;
}

/**
 * @param {object} args
 * @param {string} args.base
 */
async function runLive(args) {
  const base = args.base.replace(/\/$/, "");
  const origin = new URL(base).origin;
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];

  function addRow(url, status, ms, result, detail = "") {
    rows.push({ url, status, ms, result, detail });
    const line = `${String(status).padStart(3)} ${String(ms).padStart(5)}ms  ${result.padEnd(6)}  ${url}${detail ? `  (${detail})` : ""}`;
    console.log(line);
    if (result === "FAIL") failures.push(`${url}: ${detail || "failed"}`);
  }

  // Sitemap first (needed for dynamic targets)
  let sitemapLocs = [];
  try {
    const sm = await httpGet(`${base}/sitemap.xml`, { accept: "application/xml,text/xml,*/*" });
    const locs = parseSitemapLocs(sm.text);
    sitemapLocs = locs;
    const ok =
      sm.status === 200 &&
      /<\?xml|<\s*urlset/i.test(sm.text) &&
      locs.length >= 1;
    addRow(
      "/sitemap.xml",
      sm.status,
      sm.ms,
      ok ? "PASS" : "FAIL",
      ok ? `${locs.length} loc` : "need 200 XML with >=1 loc"
    );
  } catch (err) {
    addRow("/sitemap.xml", 0, 0, "FAIL", sanitiseExtract(String(err)));
  }

  const firstCategory =
    sitemapLocs.find((u) => {
      try {
        return new URL(u).pathname.startsWith("/category/");
      } catch {
        return false;
      }
    }) || `${base}/category/subscription`;

  const firstProduct =
    sitemapLocs.find((u) => {
      try {
        const p = new URL(u).pathname;
        return p.startsWith("/products/") && p !== "/products/";
      } catch {
        return false;
      }
    }) || null;

  const firstBlog =
    sitemapLocs.find((u) => {
      try {
        const p = new URL(u).pathname;
        return p.startsWith("/blog/") && p !== "/blog/";
      } catch {
        return false;
      }
    }) || null;

  const pagePaths = [
    "/",
    "/products",
    (() => {
      try {
        return new URL(firstCategory).pathname;
      } catch {
        return "/category/subscription";
      }
    })(),
    firstProduct
      ? (() => {
          try {
            return new URL(firstProduct).pathname;
          } catch {
            return null;
          }
        })()
      : null,
    "/about",
    "/contact",
    "/faq",
    "/blog",
    firstBlog
      ? (() => {
          try {
            return new URL(firstBlog).pathname;
          } catch {
            return null;
          }
        })()
      : null,
    "/terms",
    "/privacy-policy",
    "/refund-policy",
    "/order-tracking",
    "/cart",
  ].filter(Boolean);

  for (const path of pagePaths) {
    try {
      const res = await httpGetFollow(`${base}${path}`, origin);
      const title = extractTitle(res.text);
      const h1n = countTag(res.text, "h1");
      if (h1n !== 1) {
        notes.push(`${path}: h1 count=${h1n} (reported, non-fatal)`);
      }
      const ok = res.status === 200 && title.length > 0;
      addRow(
        path,
        res.status,
        res.ms,
        ok ? "PASS" : "FAIL",
        `title=${title ? "yes" : "no"} h1=${h1n}`
      );
    } catch (err) {
      addRow(path, 0, 0, "FAIL", sanitiseExtract(String(err)));
    }
  }

  // /api/products
  try {
    const res = await httpGet(`${base}/api/products`, { accept: "application/json" });
    let ok = false;
    let detail = "";
    if (res.status === 200) {
      try {
        const data = JSON.parse(res.text);
        ok = Array.isArray(data) && data.length >= 1;
        detail = ok ? `array len=${data.length}` : "need JSON array len>=1";
      } catch {
        detail = "invalid JSON";
      }
    } else {
      detail = "need HTTP 200";
    }
    addRow("/api/products", res.status, res.ms, ok ? "PASS" : "FAIL", detail);
  } catch (err) {
    addRow("/api/products", 0, 0, "FAIL", sanitiseExtract(String(err)));
  }

  // robots.txt
  try {
    const res = await httpGet(`${base}/robots.txt`, { accept: "text/plain,*/*" });
    const ok = res.status === 200 && res.text.trim().length > 0;
    addRow("/robots.txt", res.status, res.ms, ok ? "PASS" : "FAIL", ok ? "text" : "need 200 text");
  } catch (err) {
    addRow("/robots.txt", 0, 0, "FAIL", sanitiseExtract(String(err)));
  }

  // Auth boundary negatives
  for (const path of ["/api/admin-orders", "/api/admin-products"]) {
    try {
      const res = await httpGet(`${base}${path}`, { accept: "application/json" });
      const ok = res.status === 401 || res.status === 403;
      addRow(
        path,
        res.status,
        res.ms,
        ok ? "PASS" : "FAIL",
        ok ? "auth boundary" : "expected 401 or 403"
      );
    } catch (err) {
      addRow(path, 0, 0, "FAIL", sanitiseExtract(String(err)));
    }
  }

  // /sidhu — 200 or redirect; no order data markers
  try {
    const res = await httpGet(`${base}/sidhu`);
    let statusOk = res.status === 200 || (res.status >= 300 && res.status < 400);
    let body = res.text;
    let finalStatus = res.status;
    let ms = res.ms;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        const next = new URL(loc, `${base}/sidhu`);
        if (next.origin === origin) {
          const followed = await httpGetFollow(next.href, origin);
          body = followed.text;
          finalStatus = followed.status;
          ms += followed.ms;
          statusOk = followed.status === 200 || statusOk;
        }
      }
    }
    const hits = findOrderMarkers(body);
    const ok = statusOk && hits.length === 0;
    addRow(
      "/sidhu",
      finalStatus,
      ms,
      ok ? "PASS" : "FAIL",
      hits.length ? `order markers: ${hits.length}` : "no order markers"
    );
  } catch (err) {
    addRow("/sidhu", 0, 0, "FAIL", sanitiseExtract(String(err)));
  }

  for (const n of notes) console.log(`NOTE  ${n}`);
  console.log(`Requests: ${requestCount}/${MAX_REQUESTS}`);
  const passed = failures.length === 0;
  console.log(passed ? "SUMMARY: PASS" : `SUMMARY: FAIL (${failures.length})`);

  const result = {
    ok: passed,
    base,
    requestCount,
    failures,
    notes,
    rows,
  };
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(result, null, 2), "utf8");
  }
  return passed ? EXIT_OK : EXIT_FAIL;
}

function selfTest() {
  const asserts = [];
  function check(name, cond) {
    asserts.push({ name, ok: !!cond });
    if (!cond) console.error(`ASSERT FAIL: ${name}`);
  }

  check("title extract", extractTitle("<html><title>  Hello  </title></html>") === "Hello");
  check("title missing", extractTitle("<html></html>") === "");
  check("h1 count 1", countTag("<h1>a</h1><p>x</p>", "h1") === 1);
  check("h1 count 2", countTag("<h1>a</h1><h1 class='x'>b</h1>", "h1") === 2);
  check("h1 count 0", countTag("<h2>a</h2>", "h1") === 0);
  const locs = parseSitemapLocs(
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>'
  );
  check("sitemap locs", locs.length === 2 && locs[0].endsWith("/a"));
  check("order markers hit", findOrderMarkers('{"customer_email":"x"}').includes("customer_email"));
  check("order markers miss", findOrderMarkers("<html>login</html>").length === 0);
  check("sanitise", sanitiseExtract("a".repeat(100)).endsWith("…"));

  const failed = asserts.filter((a) => !a.ok);
  console.log(`self-test: ${asserts.length - failed.length}/${asserts.length} passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (args.selfTest) {
    process.exit(selfTest());
  }
  try {
    const code = await runLive(args);
    process.exit(code);
  } catch (err) {
    console.error(`RUNTIME: ${sanitiseExtract(String(err), 200)}`);
    process.exit(EXIT_USAGE);
  }
}

main();
