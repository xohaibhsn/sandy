#!/usr/bin/env node
/**
 * sandy-qa freshness-probe — CMS freshness tester (read-only GET polling).
 * Scripts never log in. Owner performs admin edits manually.
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const UA = "sandy-qa/1.0 (+read-only)";
const DEFAULT_BASE = "https://sandy.com.pk";
const TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL = 5;
const MIN_INTERVAL = 3;
const MAX_REQUESTS_PER_URL = 60;
const DEFAULT_POLL_TIMEOUT = 300;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

let globalRequests = 0;

function usage(code = EXIT_USAGE) {
  console.error(`Usage: node scripts/qa/freshness-probe.mjs --marker "<text>" [--expect absent] [--urls "/,/about,/faq"] [--interval 5] [--timeout 300] [--base <url>] [--json <file>] [--self-test]

Polls public pages and public GET APIs for a marker substring.
Minimum interval ${MIN_INTERVAL}s, hard cap ${MAX_REQUESTS_PER_URL} requests per URL.
Exit: 0=marker seen/absent as expected on all targets, 1=NOT-SEEN on any, 2=usage/runtime error.`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    marker: null,
    expect: "present",
    urls: ["/", "/about", "/faq"],
    interval: DEFAULT_INTERVAL,
    timeout: DEFAULT_POLL_TIMEOUT,
    json: null,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--expect") {
      const v = argv[++i];
      if (v !== "absent" && v !== "present") usage();
      out.expect = v;
    } else if (a === "--marker") {
      const v = argv[++i];
      if (!v) usage();
      out.marker = v;
    } else if (a === "--urls") {
      const v = argv[++i];
      if (!v) usage();
      out.urls = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--interval") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) usage();
      out.interval = v;
    } else if (a === "--timeout") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) usage();
      out.timeout = v;
    } else if (a === "--base") {
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

function sanitiseExtract(s, max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function snippetAround(text, marker, max = 80) {
  const idx = text.indexOf(marker);
  if (idx < 0) return "";
  const start = Math.max(0, idx - Math.floor((max - marker.length) / 2));
  return sanitiseExtract(text.slice(start, start + max), max);
}

async function httpGet(url) {
  globalRequests += 1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
    });
    const ms = Math.round(performance.now() - t0);
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    return { status: res.status, ms, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
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

function markerState(text, marker) {
  const decoded = decodeBasic(text);
  return decoded.includes(marker);
}

const API_CANDIDATES = [
  "/api/site-content?page=all",
  "/api/products",
  "/api/faqs",
  "/api/blog",
  "/api/sections?page=home",
];

/**
 * Probe one URL until expect satisfied or caps hit.
 */
async function probeUrl(fullUrl, marker, expect, intervalSec, timeoutSec) {
  const started = Date.now();
  let requests = 0;
  let firstSeenAt = null;
  let lastHad = null;
  let inHtml = false;
  let inJson = false;
  let lastStatus = 0;
  let snippet = "";

  while (requests < MAX_REQUESTS_PER_URL) {
    const elapsedSec = (Date.now() - started) / 1000;
    if (elapsedSec > timeoutSec && requests > 0) break;

    const res = await httpGet(fullUrl);
    requests += 1;
    lastStatus = res.status;
    const had = markerState(res.text, marker);
    lastHad = had;

    const looksJson =
      /^\s*[\[{]/.test(res.text) ||
      (res.finalUrl.includes("/api/") && res.status === 200);

    if (had) {
      if (firstSeenAt == null) firstSeenAt = elapsedSec;
      snippet = snippetAround(decodeBasic(res.text), marker);
      if (looksJson) inJson = true;
      else inHtml = true;
      // Raw HTML pages may also embed JSON; classify by URL family
      if (!fullUrl.includes("/api/")) inHtml = true;
      else inJson = true;
    }

    const satisfied =
      expect === "present" ? had : expect === "absent" ? !had : false;
    if (satisfied && requests >= 1) {
      return {
        url: fullUrl,
        status: lastStatus,
        requests,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        result: expect === "present" ? "SEEN" : "ABSENT",
        inHtml,
        inJson,
        snippet,
      };
    }

    const remaining = timeoutSec - (Date.now() - started) / 1000;
    if (remaining <= 0) break;
    await sleep(Math.min(intervalSec * 1000, Math.max(0, remaining * 1000)));
  }

  return {
    url: fullUrl,
    status: lastStatus,
    requests,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    result: "NOT-SEEN",
    inHtml,
    inJson,
    lastHad,
    snippet,
  };
}

async function discoverPublicApis(base) {
  const publicApis = [];
  for (const path of API_CANDIDATES) {
    try {
      const res = await httpGet(`${base}${path}`);
      if (res.status === 200) publicApis.push(path);
      else console.log(`SKIP API ${path} status=${res.status}`);
    } catch (err) {
      console.log(`SKIP API ${path} error=${sanitiseExtract(String(err), 60)}`);
    }
    await sleep(300);
  }
  return publicApis;
}

async function runLive(args) {
  if (!args.marker) usage();
  const interval = Math.max(MIN_INTERVAL, Number(args.interval) || DEFAULT_INTERVAL);
  const timeout = Math.max(1, Number(args.timeout) || DEFAULT_POLL_TIMEOUT);
  const base = args.base.replace(/\/$/, "");
  const marker = args.marker;
  const expect = args.expect;

  const pageUrls = args.urls.map((u) =>
    u.startsWith("http") ? u : `${base}${u.startsWith("/") ? u : `/${u}`}`
  );

  console.log(`Discovering public APIs at ${base}…`);
  const apis = await discoverPublicApis(base);
  const apiUrls = apis.map((p) => `${base}${p}`);

  const targets = [...pageUrls, ...apiUrls];
  console.log(
    `Probing ${targets.length} URLs for marker (expect=${expect}, interval=${interval}s, timeout=${timeout}s)`
  );
  console.log(`Marker length=${marker.length} (value not printed)`);

  /** @type {Array<object>} */
  const rows = [];
  const pageSet = new Set(pageUrls);
  for (const url of targets) {
    const row = await probeUrl(url, marker, expect, interval, timeout);
    row.kind = pageSet.has(url) ? "page" : "api";
    rows.push(row);
    const where =
      row.result === "SEEN" || row.result === "ABSENT"
        ? ` html=${row.inHtml ? "Y" : "N"} apiJson=${row.inJson ? "Y" : "N"}`
        : "";
    console.log(
      `${row.result.padEnd(8)} ${String(row.seconds).padStart(6)}s  req=${String(row.requests).padStart(2)}  [${row.kind}] ${url}${where}`
    );
    if (row.snippet) console.log(`         snippet: ${row.snippet}`);
  }

  // Exit code is driven by --urls page targets. API probes are diagnostic
  // (a marker edited into one CMS text field will not appear in every public API).
  const pageFailed = rows.filter((r) => r.kind === "page" && r.result === "NOT-SEEN");
  const apiMisses = rows.filter((r) => r.kind === "api" && r.result === "NOT-SEEN");
  const result = {
    ok: pageFailed.length === 0,
    expect,
    markerLength: marker.length,
    interval,
    timeout,
    globalRequests,
    pageFailed: pageFailed.length,
    apiNotSeen: apiMisses.length,
    rows: rows.map((r) => ({
      url: r.url,
      kind: r.kind,
      status: r.status,
      requests: r.requests,
      seconds: r.seconds,
      result: r.result,
      inHtml: r.inHtml,
      inJson: r.inJson,
      snippet: r.snippet,
    })),
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2), "utf8");
  console.log(`Total HTTP requests: ${globalRequests}`);
  if (apiMisses.length) {
    console.log(`NOTE  ${apiMisses.length} API URL(s) did not show marker (diagnostic, non-fatal)`);
  }
  console.log(
    pageFailed.length === 0
      ? "SUMMARY: PASS"
      : `SUMMARY: FAIL (${pageFailed.length} page NOT-SEEN)`
  );
  return pageFailed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

function selfTest() {
  const asserts = [];
  function check(name, cond) {
    asserts.push({ name, ok: !!cond });
    if (!cond) console.error(`ASSERT FAIL: ${name}`);
  }

  check("present hit", markerState("Hello QA-123 World", "QA-123") === true);
  check("present miss", markerState("Hello World", "QA-123") === false);
  check("entity decode", markerState("S&amp;Y store", "S&Y") === true);
  check("snippet max", snippetAround("xxxxMARKERYYYY", "MARKER", 80).length <= 80);
  check("sanitise", sanitiseExtract("a".repeat(100)).endsWith("…"));
  check("min interval enforced conceptually", Math.max(MIN_INTERVAL, 1) === 3);

  const failed = asserts.filter((a) => !a.ok);
  console.log(`self-test: ${asserts.length - failed.length}/${asserts.length} passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (args.selfTest) process.exit(selfTest());
  try {
    const code = await runLive(args);
    process.exit(code);
  } catch (err) {
    console.error(`RUNTIME: ${sanitiseExtract(String(err), 200)}`);
    process.exit(EXIT_USAGE);
  }
}

main();
