#!/usr/bin/env node
/**
 * sandy-qa check-runtime-ddl — guard against schema changes (DDL) in runtime code.
 *
 * Scans app/, pages/, lib/, components/, hooks/ and root *.ts for DDL statements
 * (CREATE TABLE/INDEX, ALTER TABLE, DROP TABLE/INDEX/COLUMN, RENAME TABLE, TRUNCATE).
 * Compares per-file counts with scripts/qa/runtime-ddl-allowlist.json ({ file: max count }).
 *
 * Exit: 0 = no new DDL, 1 = non-allowlisted file has DDL or a count rose above its allowlist,
 *       2 = usage / runtime error.
 *
 * Read-only probes (SHOW COLUMNS, SHOW CREATE TABLE, INFORMATION_SCHEMA SELECTs) are not DDL
 * and are never flagged. tests/, migrations/, scripts/, node_modules and .next are ignored.
 * Only file path, count and rule names are printed — never source lines.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowlistPath = path.join(repoRoot, "scripts", "qa", "runtime-ddl-allowlist.json");

const SCAN_DIRS = ["app", "pages", "lib", "components", "hooks"];
const IGNORED_DIRS = new Set(["node_modules", ".next", "tests", "migrations", "scripts", ".git"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Each rule has a name and a global regex. SHOW CREATE TABLE is a read-only probe, so it is excluded. */
const RULES = [
  { name: "CREATE TABLE", re: /(?<!\bSHOW\s+)\bCREATE\s+(?:TEMPORARY\s+)?TABLE\b/gi },
  { name: "CREATE INDEX", re: /\bCREATE\s+(?:UNIQUE\s+|FULLTEXT\s+)?INDEX\b/gi },
  { name: "ALTER TABLE", re: /\bALTER\s+TABLE\b/gi },
  { name: "DROP TABLE", re: /\bDROP\s+(?:TEMPORARY\s+)?TABLE\b/gi },
  { name: "DROP INDEX", re: /\bDROP\s+INDEX\b/gi },
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi },
  { name: "RENAME TABLE", re: /\bRENAME\s+TABLE\b/gi },
  // Bare TRUNCATE is ordinary English in prose and code, so it only counts as SQL with TABLE or in upper case.
  { name: "TRUNCATE", re: /\bTRUNCATE\s+TABLE\b/gi },
  { name: "TRUNCATE", re: /\bTRUNCATE\s+(?!TABLE\b)[`\w]/g },
];

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Returns { total, byRule } for one file's source text. Comment-only lines are skipped. */
export function countDdl(source) {
  const code = source
    .split(/\r?\n/)
    .filter((line) => !isCommentLine(line))
    .join("\n");
  const byRule = {};
  let total = 0;
  for (const { name, re } of RULES) {
    const n = (code.match(re) || []).length;
    if (n > 0) {
      byRule[name] = (byRule[name] || 0) + n;
      total += n;
    }
  }
  return { total, byRule };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(repoRoot, dir);
    try {
      walk(abs, files);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path.join(repoRoot, entry.name));
  }
  return files;
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("allowlist must be a JSON object of { file: maxCount }");
  }
  for (const [file, max] of Object.entries(raw)) {
    if (!Number.isInteger(max) || max < 0) throw new Error(`allowlist entry for ${file} must be a non-negative integer`);
  }
  return raw;
}

function main() {
  let allowlist;
  try {
    allowlist = loadAllowlist();
  } catch (err) {
    console.error(`check-runtime-ddl: cannot read allowlist: ${err.message}`);
    return EXIT_USAGE;
  }

  const found = new Map();
  for (const file of collectFiles()) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const { total, byRule } = countDdl(readFileSync(file, "utf8"));
    if (total > 0) found.set(rel, { total, byRule });
  }

  const violations = [];
  const shrunk = [];
  for (const [rel, { total, byRule }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    const rules = Object.entries(byRule)
      .map(([name, n]) => `${name} x${n}`)
      .join(", ");
    const max = allowlist[rel];
    if (max === undefined) {
      violations.push(`NEW   ${rel}: ${total} DDL statement(s) in a non-allowlisted file (${rules})`);
    } else if (total > max) {
      violations.push(`RISE  ${rel}: ${total} DDL statement(s), allowlist max is ${max} (${rules})`);
    } else if (total < max) {
      shrunk.push(`${rel}: ${total} < allowlisted ${max}`);
    }
  }
  for (const [rel, max] of Object.entries(allowlist)) {
    if (!found.has(rel) && max > 0) shrunk.push(`${rel}: 0 < allowlisted ${max}`);
  }

  const totalFound = [...found.values()].reduce((sum, v) => sum + v.total, 0);
  console.log(`check-runtime-ddl: ${found.size} file(s), ${totalFound} DDL statement(s) in runtime code`);

  if (shrunk.length > 0) {
    console.log("NOTE: allowlist can be tightened (counts went down):");
    for (const line of shrunk) console.log(`  ${line}`);
  }
  if (violations.length > 0) {
    console.error("FAIL: runtime DDL is not allowed to grow:");
    for (const line of violations) console.error(`  ${line}`);
    return EXIT_FAIL;
  }
  console.log("OK: no new runtime DDL.");
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
