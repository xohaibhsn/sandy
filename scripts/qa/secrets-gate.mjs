#!/usr/bin/env node
/**
 * sandy-qa secrets-gate — scan tracked (or staged) files for secret-like patterns.
 * REPORT ONLY: path, line number, pattern id, match LENGTH. Never print matched values.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

function usage(code = EXIT_USAGE) {
  console.error(`Usage: node scripts/qa/secrets-gate.mjs [--staged] [--baseline <file>] [--baseline-out <file>] [--json <file>] [--self-test]

Scans git-tracked files (or staged diff with --staged) for secret-like patterns.
Reports path, line, patternId, match length only — never the matched value.
Exit: 0=clean (or no new findings vs baseline), 1=findings, 2=usage/runtime error.`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    staged: false,
    baseline: null,
    baselineOut: null,
    json: null,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--staged") out.staged = true;
    else if (a === "--baseline") {
      const v = argv[++i];
      if (!v) usage();
      out.baseline = v;
    } else if (a === "--baseline-out") {
      const v = argv[++i];
      if (!v) usage();
      out.baselineOut = v;
    } else if (a === "--json") {
      const v = argv[++i];
      if (!v) usage();
      out.json = v;
    } else usage();
  }
  return out;
}

/** Build patterns without embedding contiguous private-key / credential marker literals. */
function buildPatterns() {
  const begin = "BEGIN";
  const end = "END";
  const priv = "PRIVATE";
  const key = "KEY";
  const dash3 = "-".repeat(3);
  const privBlock = new RegExp(
    `${dash3}${begin} (?:RSA |EC |OPENSSH |DSA )?${priv} ${key}${dash3}`,
    "g"
  );
  const endBlock = new RegExp(
    `${dash3}${end} (?:RSA |EC |OPENSSH |DSA )?${priv} ${key}${dash3}`,
    "g"
  );

  const bearer = ["Bea", "rer"].join("");
  const basic = ["Bas", "ic"].join("");
  const awsAKIA = ["AK", "IA"].join("");
  const googAIza = ["AI", "za"].join("");
  const slackXox = ["xox", "[baprs]-"].join("");
  const jwtDot = ["eyJ", "[A-Za-z0-9_-]+", "\\.", "[A-Za-z0-9_-]+", "\\.", "[A-Za-z0-9_-]+"].join(
    ""
  );

  return [
    { id: "private_key_begin", re: privBlock },
    { id: "private_key_end", re: endBlock },
    {
      id: "url_embedded_credentials",
      re: /[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^\/\s@]+@/gi,
    },
    {
      id: "bearer_literal",
      re: new RegExp(`(?:${bearer}|${basic})\\s+[A-Za-z0-9._\\-+/=]{12,}`, "gi"),
    },
    {
      id: "aws_access_key_id",
      re: new RegExp(`\\b${awsAKIA}[0-9A-Z]{16}\\b`, "g"),
    },
    {
      id: "google_api_key",
      re: new RegExp(`\\b${googAIza}[0-9A-Za-z_-]{20,}\\b`, "g"),
    },
    {
      id: "slack_token",
      re: new RegExp(`\\b${slackXox}[0-9A-Za-z-]{10,}`, "g"),
    },
    {
      id: "jwt_shaped",
      re: new RegExp(`\\b${jwtDot}\\b`, "g"),
    },
    {
      id: "secret_assignment",
      re: /\b(?:password|passwd|secret|token|api_key|db_pass|db_user|db_host)\b\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    },
  ];
}

const SKIP_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

function isSkippedPath(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  if (norm.includes("node_modules/")) return true;
  const base = path.posix.basename(norm);
  if (SKIP_NAMES.has(base)) return true;
  return false;
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function gitLines(args) {
  const out = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split(/\r?\n/).filter((l) => l.length > 0);
}

function listTrackedFiles() {
  return gitLines(["ls-files"]);
}

function listStagedFiles() {
  return gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
}

function getStagedContent(filePath) {
  try {
    return execFileSync("git", ["--no-optional-locks", "show", `:${filePath}`], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function getHeadContent(filePath) {
  // Read via git only — never open the working tree (OneDrive cloud-only placeholders).
  try {
    return execFileSync("git", ["--no-optional-locks", "show", `HEAD:${filePath}`], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * @returns {Array<{path:string,line:number,patternId:string,length:number}>}
 */
function scanContent(filePath, text, patterns) {
  /** @type {Array<{path:string,line:number,patternId:string,length:number}>} */
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        findings.push({
          path: filePath.replace(/\\/g, "/"),
          line: i + 1,
          patternId: p.id,
          length: m[0].length,
        });
        if (m[0].length === 0) p.re.lastIndex += 1;
      }
    }
  }
  return findings;
}

function lengthClass(n) {
  if (n < 16) return "lt16";
  if (n < 32) return "16-31";
  if (n < 64) return "32-63";
  if (n < 128) return "64-127";
  return "128+";
}

function baselineKey(f) {
  return `${f.path}|${f.patternId}`;
}

function countByKey(findings) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const f of findings) {
    const k = baselineKey(f);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function runScan(args) {
  const patterns = buildPatterns();
  const files = args.staged ? listStagedFiles() : listTrackedFiles();
  /** @type {Array<{path:string,line:number,patternId:string,length:number}>} */
  let findings = [];

  for (const file of files) {
    if (isSkippedPath(file)) continue;
    const buf = args.staged ? getStagedContent(file) : getHeadContent(file);
    if (!buf) continue;
    if (isBinaryBuffer(buf)) continue;
    const text = buf.toString("utf8");
    findings = findings.concat(scanContent(file, text, patterns));
  }

  if (args.baselineOut) {
    const counts = countByKey(findings);
    writeFileSync(
      args.baselineOut,
      JSON.stringify({ generatedAt: new Date().toISOString(), counts }, null, 2),
      "utf8"
    );
    console.log(`Wrote baseline counts to ${args.baselineOut}`);
  }

  /** @type {Array<{path:string,line:number,patternId:string,length:number}>} */
  let reportable = findings;
  if (args.baseline) {
    const base = JSON.parse(readFileSync(args.baseline, "utf8"));
    const prev = base.counts || base;
    const cur = countByKey(findings);
    /** @type {Set<string>} */
    const hot = new Set();
    for (const [k, n] of Object.entries(cur)) {
      const before = prev[k] || 0;
      if (n > before) hot.add(k);
    }
    reportable = findings.filter((f) => hot.has(baselineKey(f)));
  }

  /** @type {Record<string, number>} */
  const byPattern = {};
  /** @type {Record<string, number>} */
  const byLengthClass = {};
  for (const f of findings) {
    byPattern[f.patternId] = (byPattern[f.patternId] || 0) + 1;
    const lc = lengthClass(f.length);
    byLengthClass[lc] = (byLengthClass[lc] || 0) + 1;
  }

  for (const f of reportable) {
    console.log(`${f.path}:${f.line}  ${f.patternId}  len=${f.length}`);
  }

  console.log("--- summary (all findings in scan scope) ---");
  for (const [id, n] of Object.entries(byPattern).sort()) {
    console.log(`pattern ${id}: ${n}`);
  }
  for (const [lc, n] of Object.entries(byLengthClass).sort()) {
    console.log(`lengthClass ${lc}: ${n}`);
  }
  console.log(`total findings: ${findings.length}`);
  console.log(`reportable: ${reportable.length}`);

  const result = {
    ok: reportable.length === 0,
    total: findings.length,
    reportable: reportable.length,
    byPattern,
    byLengthClass,
    items: reportable.map((f) => ({
      path: f.path,
      line: f.line,
      patternId: f.patternId,
      length: f.length,
    })),
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2), "utf8");

  const passed = reportable.length === 0;
  console.log(passed ? "SUMMARY: PASS" : `SUMMARY: FAIL (${reportable.length})`);
  return passed ? EXIT_OK : EXIT_FAIL;
}

function selfTest() {
  const asserts = [];
  function check(name, cond) {
    asserts.push({ name, ok: !!cond });
    if (!cond) console.error(`ASSERT FAIL: ${name}`);
  }

  const patterns = buildPatterns();
  const begin = ["-", "-", "-", "BEGIN", " ", "PRIVATE", " ", "KEY", "-", "-", "-"].join("");
  const urlCred = ["https://", "user", ":", "password", "@", "example.com/x"].join("");
  const assign = ["const ", "password", " = ", '"', "hunter2xx", '"'].join("");
  const sample = [
    begin,
    urlCred,
    ["Bea", "rer ", "aaaaaaaaaaaa"].join(""),
    ["AK", "IA", "IOSFODNN7EXAMPLE"].join(""),
    ["AI", "za", "SyA", "b".repeat(20)].join(""),
    ["xox", "b-", "123456789012-abcdefghij"].join(""),
    ["eyJ", "hbGciOi", ".", "eyJ", "sub", ".", "sig"].join(""),
    assign,
    "const safe = 1",
  ].join("\n");

  const findings = scanContent("fixture.txt", sample, patterns);
  check("found private key", findings.some((f) => f.patternId === "private_key_begin"));
  check("found url creds", findings.some((f) => f.patternId === "url_embedded_credentials"));
  check("found bearer", findings.some((f) => f.patternId === "bearer_literal"));
  check("found aws", findings.some((f) => f.patternId === "aws_access_key_id"));
  check("found google", findings.some((f) => f.patternId === "google_api_key"));
  check("found slack", findings.some((f) => f.patternId === "slack_token"));
  check("found jwt", findings.some((f) => f.patternId === "jwt_shaped"));
  check("found assignment", findings.some((f) => f.patternId === "secret_assignment"));
  check("reports length only shape", findings.every((f) => typeof f.length === "number" && f.length > 0));
  check("skip lockfile", isSkippedPath("package-lock.json"));
  check("skip node_modules", isSkippedPath("node_modules/x/y.js"));
  check("length class", lengthClass(10) === "lt16" && lengthClass(40) === "32-63");

  // Ensure this source file does not embed the contiguous PEM header as one literal
  const selfSrc = readFileSync(new URL(import.meta.url), "utf8");
  const contiguous = ["BEGIN", " PRIVATE ", "KEY"].join("");
  check("self source avoids contiguous marker", !selfSrc.includes(contiguous));

  const failed = asserts.filter((a) => !a.ok);
  console.log(`self-test: ${asserts.length - failed.length}/${asserts.length} passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (args.selfTest) process.exit(selfTest());
  try {
    process.exit(runScan(args));
  } catch (err) {
    console.error(`RUNTIME: ${String(err).slice(0, 200)}`);
    process.exit(EXIT_USAGE);
  }
}

main();
