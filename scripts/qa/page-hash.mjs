#!/usr/bin/env node
/**
 * sandy-qa page-hash — 12-page SEO fingerprint + compare.
 * Raw HTML only (no JS execution). GET only.
 *
 * IMPORTANT: Re-take the baseline after the catalog or CMS content
 * legitimately changes — resolved product/category/blog URLs shift with the catalog.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const UA = "sandy-qa/1.0 (+read-only)";
const DEFAULT_BASE = "https://sandy.com.pk";
const TIMEOUT_MS = 15_000;
const MIN_GAP_MS = 300;
const MAX_REQUESTS = 30;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

let requestCount = 0;
let lastRequestAt = 0;

function usage(code = EXIT_USAGE) {
  console.error(`Usage:
  node scripts/qa/page-hash.mjs --out <baseline.json> [--base <url>] [--commit <sha>] [--json <file>]
  node scripts/qa/page-hash.mjs --compare <baseline.json> [--base <url>] [--json <file>]
  node scripts/qa/page-hash.mjs --self-test

Captures SEO fingerprints from raw HTML (no JS execution).
Baseline MUST be re-taken after catalog or CMS content legitimately changes.
Exit: 0=pass, 1=seoFingerprintHash differs (compare), 2=usage/runtime error.
textHash differences are WARN only.`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    out: null,
    compare: null,
    commit: null,
    json: null,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (!v) usage();
      out.base = v.replace(/\/$/, "");
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) usage();
      out.out = v;
    } else if (a === "--compare") {
      const v = argv[++i];
      if (!v) usage();
      out.compare = v;
    } else if (a === "--commit") {
      const v = argv[++i];
      if (!v) usage();
      out.commit = v;
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
  if (lastRequestAt && elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
}

async function httpGet(url) {
  if (requestCount >= MAX_REQUESTS) throw new Error(`Request budget exceeded (${MAX_REQUESTS})`);
  await rateLimit();
  requestCount += 1;
  lastRequestAt = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xml,*/*" },
    });
    const ms = Math.round(performance.now() - t0);
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    return { status: res.status, ms, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function sanitiseExtract(s, max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Canonical JSON with sorted object keys (arrays keep order). */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}

function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) locs.push(m[1].trim());
  return locs;
}

function metaContent(html, name) {
  const re = new RegExp(
    `<meta\\b[^>]*(?:name|property)=["']${name}["'][^>]*>`,
    "i"
  );
  const tag = html.match(re);
  if (!tag) return "";
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeBasic(c[1].trim()) : "";
}

function linkHref(html, rel) {
  const re = new RegExp(`<link\\b[^>]*rel=["']${rel}["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return "";
  const h = tag[0].match(/href=["']([^"']*)["']/i);
  return h ? decodeBasic(h[1].trim()) : "";
}

function allHreflang(html) {
  const out = [];
  const re = /<link\b[^>]*rel=["']alternate["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const hl = tag.match(/hreflang=["']([^"']*)["']/i);
    const href = tag.match(/href=["']([^"']*)["']/i);
    if (hl && href) {
      out.push({ hreflang: decodeBasic(hl[1]), href: decodeBasic(href[1]) });
    }
  }
  out.sort((a, b) =>
    `${a.hreflang}|${a.href}`.localeCompare(`${b.hreflang}|${b.href}`)
  );
  return out;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeBasic(m[1].replace(/\s+/g, " ").trim()) : "";
}

function extractH1s(html) {
  const out = [];
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push(
      decodeBasic(
        m[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
    );
  }
  return out;
}

function extractHtmlLang(html) {
  const m = html.match(/<html\b[^>]*\blang=["']([^"']*)["']/i);
  return m ? decodeBasic(m[1].trim()) : "";
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      blocks.push(JSON.parse(canonicalJson(parsed)));
    } catch {
      blocks.push({ _unparsed: true, length: raw.length });
    }
  }
  return blocks;
}

function decodeBasic(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Strip scripts/styles/noscript and build noise before visible-text extraction.
 */
function normalisedVisibleText(html) {
  let h = String(html);
  h = h.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  h = h.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  h = h.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  // Drop build-specific noise remnants
  h = h.replace(/\/_next\/static\/[^"'\\\s>]+/gi, " ");
  h = h.replace(/\bnonce=["'][^"']*["']/gi, " ");
  h = h.replace(/<[^>]+>/g, " ");
  h = decodeBasic(h);
  h = h.replace(/\s+/g, " ").trim();
  return h;
}

function fingerprintPage(status, finalUrl, html) {
  const fields = {
    status,
    finalUrl,
    title: extractTitle(html),
    metaDescription: metaContent(html, "description"),
    canonical: linkHref(html, "canonical"),
    metaRobots: metaContent(html, "robots"),
    h1: extractH1s(html),
    ogTitle: metaContent(html, "og:title"),
    ogDescription: metaContent(html, "og:description"),
    ogUrl: metaContent(html, "og:url"),
    hreflang: allHreflang(html),
    jsonLd: extractJsonLd(html),
    htmlLang: extractHtmlLang(html),
  };
  const text = normalisedVisibleText(html);
  const seoFingerprintHash = sha256(canonicalJson(fields));
  const textHash = sha256(text);
  return {
    ...fields,
    textHash,
    textLength: text.length,
    seoFingerprintHash,
  };
}

function resolveTargets(base, locs) {
  const firstCategory =
    locs.find((u) => {
      try {
        return new URL(u).pathname.startsWith("/category/");
      } catch {
        return false;
      }
    }) || null;
  const firstProduct =
    locs.find((u) => {
      try {
        const p = new URL(u).pathname;
        return p.startsWith("/products/") && p.length > "/products/".length;
      } catch {
        return false;
      }
    }) || null;
  const firstBlog =
    locs.find((u) => {
      try {
        const p = new URL(u).pathname;
        return p.startsWith("/blog/") && p.length > "/blog/".length;
      } catch {
        return false;
      }
    }) || null;

  const pathOrUrl = (label, fallbackPath, absolute) => {
    if (absolute) {
      try {
        return { id: label, path: new URL(absolute).pathname, url: absolute };
      } catch {
        /* fall through */
      }
    }
    return { id: label, path: fallbackPath, url: `${base}${fallbackPath}` };
  };

  return [
    pathOrUrl("home", "/", `${base}/`),
    pathOrUrl("products", "/products", `${base}/products`),
    pathOrUrl("category", "/category/subscription", firstCategory),
    pathOrUrl("product", "/products/_missing_", firstProduct),
    pathOrUrl("about", "/about", `${base}/about`),
    pathOrUrl("contact", "/contact", `${base}/contact`),
    pathOrUrl("faq", "/faq", `${base}/faq`),
    pathOrUrl("blog", "/blog", `${base}/blog`),
    pathOrUrl("blogPost", "/blog/_missing_", firstBlog),
    pathOrUrl("terms", "/terms", `${base}/terms`),
    pathOrUrl("privacy", "/privacy-policy", `${base}/privacy-policy`),
    pathOrUrl("refund", "/refund-policy", `${base}/refund-policy`),
  ];
}

async function captureBaseline(args) {
  const base = args.base.replace(/\/$/, "");
  const sm = await httpGet(`${base}/sitemap.xml`);
  const locs = sm.status === 200 ? parseSitemapLocs(sm.text) : [];
  const targets = resolveTargets(base, locs);

  /** @type {Record<string, object>} */
  const pages = {};
  for (const t of targets) {
    if (t.path.includes("_missing_")) {
      pages[t.id] = {
        id: t.id,
        requestedUrl: t.url,
        error: "no matching URL in sitemap",
        seoFingerprintHash: null,
        textHash: null,
      };
      console.log(`SKIP  ${t.id}: no sitemap match`);
      continue;
    }
    const res = await httpGet(t.url);
    const fp = fingerprintPage(res.status, res.finalUrl, res.text);
    pages[t.id] = {
      id: t.id,
      requestedUrl: t.url,
      resolvedPath: t.path,
      ms: res.ms,
      ...fp,
    };
    console.log(
      `${t.id.padEnd(10)} ${res.status}  seo=${fp.seoFingerprintHash.slice(0, 12)}…  text=${fp.textHash.slice(0, 12)}…  h1=${fp.h1.length}`
    );
  }

  const baseline = {
    timestamp: new Date().toISOString(),
    commit: args.commit || null,
    base,
    requestCount,
    resolved: Object.fromEntries(
      Object.values(pages).map((p) => [p.id, p.requestedUrl || null])
    ),
    pages,
  };

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(baseline, null, 2), "utf8");
    console.log(`Wrote ${args.out}`);
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(baseline, null, 2), "utf8");
  console.log(`Requests: ${requestCount}/${MAX_REQUESTS}`);
  console.log("SUMMARY: baseline captured");
  return EXIT_OK;
}

function fieldDiffs(a, b) {
  const keys = [
    "status",
    "finalUrl",
    "title",
    "metaDescription",
    "canonical",
    "metaRobots",
    "h1",
    "ogTitle",
    "ogDescription",
    "ogUrl",
    "hreflang",
    "jsonLd",
    "htmlLang",
    "seoFingerprintHash",
    "textHash",
    "textLength",
  ];
  /** @type {Array<{field:string, before:unknown, after:unknown}>} */
  const diffs = [];
  for (const k of keys) {
    const left = canonicalJson(a?.[k] ?? null);
    const right = canonicalJson(b?.[k] ?? null);
    if (left !== right) diffs.push({ field: k, before: a?.[k] ?? null, after: b?.[k] ?? null });
  }
  return diffs;
}

async function compareBaseline(args) {
  const base = args.base.replace(/\/$/, "");
  const prev = JSON.parse(readFileSync(args.compare, "utf8"));
  const sm = await httpGet(`${base}/sitemap.xml`);
  const locs = sm.status === 200 ? parseSitemapLocs(sm.text) : [];
  const targets = resolveTargets(base, locs);

  let seoFail = 0;
  let textWarn = 0;
  /** @type {Array<object>} */
  const pageResults = [];

  for (const t of targets) {
    const prevPage = prev.pages?.[t.id];
    if (t.path.includes("_missing_")) {
      console.log(`SKIP  ${t.id}: no sitemap match`);
      pageResults.push({ id: t.id, skipped: true });
      continue;
    }
    const res = await httpGet(t.url);
    const fp = fingerprintPage(res.status, res.finalUrl, res.text);
    const diffs = fieldDiffs(prevPage, fp);
    const seoChanged = (prevPage?.seoFingerprintHash || null) !== fp.seoFingerprintHash;
    const textChanged = (prevPage?.textHash || null) !== fp.textHash;
    if (seoChanged) seoFail += 1;
    if (textChanged && !seoChanged) textWarn += 1;
    if (textChanged && seoChanged) {
      /* counted as seo fail; still note text */
    } else if (textChanged) {
      /* warn only */
    }

    const label = seoChanged ? "FAIL" : textChanged ? "WARN" : "PASS";
    console.log(
      `${label}  ${t.id.padEnd(10)} seo=${seoChanged ? "DIFF" : "same"} text=${textChanged ? "DIFF" : "same"}`
    );
    for (const d of diffs) {
      if (d.field === "textHash" || d.field === "textLength") {
        console.log(`  WARN field ${d.field}`);
      } else {
        console.log(
          `  DIFF field ${d.field}: ${sanitiseExtract(JSON.stringify(d.before))} -> ${sanitiseExtract(JSON.stringify(d.after))}`
        );
      }
    }
    pageResults.push({
      id: t.id,
      requestedUrl: t.url,
      label,
      seoChanged,
      textChanged,
      diffs: diffs.map((d) => ({
        field: d.field,
        before: typeof d.before === "string" ? sanitiseExtract(d.before) : d.before,
        after: typeof d.after === "string" ? sanitiseExtract(d.after) : d.after,
      })),
      current: {
        seoFingerprintHash: fp.seoFingerprintHash,
        textHash: fp.textHash,
        textLength: fp.textLength,
        status: fp.status,
        finalUrl: fp.finalUrl,
      },
    });
  }

  const result = {
    ok: seoFail === 0,
    seoFail,
    textWarn,
    requestCount,
    pageResults,
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2), "utf8");
  console.log(`Requests: ${requestCount}/${MAX_REQUESTS}`);
  console.log(
    seoFail === 0
      ? `SUMMARY: PASS (${textWarn} text WARN)`
      : `SUMMARY: FAIL (${seoFail} seoFingerprintHash diffs, ${textWarn} text WARN)`
  );
  return seoFail === 0 ? EXIT_OK : EXIT_FAIL;
}

function selfTest() {
  const asserts = [];
  function check(name, cond) {
    asserts.push({ name, ok: !!cond });
    if (!cond) console.error(`ASSERT FAIL: ${name}`);
  }

  const html = `<!doctype html><html lang="en"><head>
<title>Test &amp; Co</title>
<meta name="description" content="Hello world">
<link rel="canonical" href="https://example.com/">
<meta name="robots" content="index,follow">
<meta property="og:title" content="OG Title">
<meta property="og:description" content="OG Desc">
<meta property="og:url" content="https://example.com/">
<link rel="alternate" hreflang="en" href="https://example.com/">
<script type="application/ld+json">{"b":2,"a":1}</script>
<script src="/_next/static/chunks/abc123.js"></script>
</head><body><h1>Main</h1><p>Visible   text</p><style>.x{}</style></body></html>`;

  const fp = fingerprintPage(200, "https://example.com/", html);
  check("title decoded", fp.title === "Test & Co");
  check("meta description", fp.metaDescription === "Hello world");
  check("canonical", fp.canonical === "https://example.com/");
  check("h1", fp.h1.length === 1 && fp.h1[0] === "Main");
  check("htmlLang", fp.htmlLang === "en");
  check("jsonLd sorted", canonicalJson(fp.jsonLd[0]) === '{"a":1,"b":2}');
  check("seo hash stable", fp.seoFingerprintHash === fingerprintPage(200, "https://example.com/", html).seoFingerprintHash);
  check("text has visible", fp.textLength > 0 && normalisedVisibleText(html).includes("Visible text"));
  check("text strips script noise", !normalisedVisibleText(html).includes("_next/static"));
  check("sha", sha256("abc").length === 64);

  const a = fingerprintPage(200, "https://example.com/", html);
  const html2 = html.replace("Hello world", "Hello world!");
  const b = fingerprintPage(200, "https://example.com/", html2);
  check("seo differs on meta", a.seoFingerprintHash !== b.seoFingerprintHash);

  const failed = asserts.filter((x) => !x.ok);
  console.log(`self-test: ${asserts.length - failed.length}/${asserts.length} passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (args.selfTest) process.exit(selfTest());
  if (!args.out && !args.compare) usage();
  if (args.out && args.compare) usage();
  try {
    const code = args.compare ? await compareBaseline(args) : await captureBaseline(args);
    process.exit(code);
  } catch (err) {
    console.error(`RUNTIME: ${sanitiseExtract(String(err), 200)}`);
    process.exit(EXIT_USAGE);
  }
}

main();
