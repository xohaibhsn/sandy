#!/usr/bin/env node
/**
 * sandy-qa check-schema-coverage — every table the app SQL uses must be created
 * by a repo migration under migrations/*.sql.
 *
 * Statically extracts table names from SQL-looking string literals in pages/,
 * lib/, app/ (FROM / INTO / UPDATE / JOIN / DELETE FROM) and CREATE TABLE names
 * from migrations/*.sql. Reports used-but-not-created (must be empty unless
 * listed in schema-coverage-allowlist.json).
 *
 * False-positive handling: only snake_case identifiers that look like table
 * names are kept; SQL keywords, single-letter aliases, PascalCase type names,
 * and ALL_CAPS env-like tokens are filtered out.
 *
 * Exit: 0 = coverage OK, 1 = missing tables, 2 = usage / runtime error.
 * --self-test runs offline fixtures (no network).
 */
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowlistPath = path.join(repoRoot, "scripts", "qa", "schema-coverage-allowlist.json");

const CODE_DIRS = ["pages", "lib", "app"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", ".next", ".git"]);

const SQL_KEYWORDS = new Set(
  [
    "select",
    "from",
    "where",
    "and",
    "or",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "natural",
    "on",
    "as",
    "into",
    "values",
    "set",
    "update",
    "delete",
    "insert",
    "table",
    "if",
    "not",
    "exists",
    "null",
    "limit",
    "order",
    "by",
    "group",
    "having",
    "union",
    "all",
    "distinct",
    "case",
    "when",
    "then",
    "else",
    "end",
    "dual",
    "true",
    "false",
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "in",
    "is",
    "like",
    "between",
    "asc",
    "desc",
    "offset",
    "fetch",
    "for",
    "using",
    "with",
    "recursive",
    "over",
    "partition",
    "interval",
    "cast",
    "convert",
    "information_schema",
    "schema",
    "database",
    "databases",
    "columns",
    "tables",
    "statistics",
    "key",
    "index",
    "primary",
    "foreign",
    "references",
    "constraint",
    "default",
    "current_timestamp",
    "now",
    "replace",
    "ignore",
    "duplicate",
    "show",
    "describe",
    "explain",
    "begin",
    "commit",
    "rollback",
    "start",
    "transaction",
    "lock",
    "unlock",
    "prepare",
    "execute",
    "deallocate",
    "call",
    "procedure",
    "function",
    "trigger",
    "view",
    "temporary",
    "temp",
    "engine",
    "charset",
    "collate",
    "character",
    "use",
    "grant",
    "revoke",
    "alter",
    "create",
    "drop",
    "truncate",
    "rename",
    "add",
    "modify",
    "change",
    "column",
    "after",
    "before",
    "first",
    "last",
    "separator",
    "both",
    "leading",
    "trailing",
    "varchar",
    "int",
    "bigint",
    "decimal",
    "datetime",
    "timestamp",
    "text",
    "json",
    "enum",
    "tinyint",
    "boolean",
    "bool",
    "date",
    "time",
    "year",
    "blob",
    "longtext",
    "mediumtext",
  ].map((s) => s.toLowerCase())
);

const FROM_RE = /\bFROM\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;
const INTO_RE = /\bINTO\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;
const JOIN_RE = /\bJOIN\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;
const DELETE_RE = /\bDELETE\s+FROM\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;
/** Require SET so ON DUPLICATE KEY UPDATE <column> is not treated as a table. */
const UPDATE_RE = /\bUPDATE\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s+SET\b/gi;
const CREATE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`\.)?`?(?!IF\b)([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;

function stripSqlComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Table-ish: snake_case with at least one underscore, or a known short table name. */
const SHORT_TABLES = new Set(["faqs", "coupons", "redirects", "riders", "couriers", "customers", "products", "orders", "categories"]);

function looksLikeTableName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.includes("$")) return false;
  if (SQL_KEYWORDS.has(name.toLowerCase())) return false;
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name) && !name.includes("_")) return false; // PascalCase
  if (/^[A-Z][A-Z0-9_]+$/.test(name) && name.includes("_")) return false; // ENV_LIKE
  if (name.length <= 2 && !SHORT_TABLES.has(name.toLowerCase())) return false;
  if (name.includes("_") || SHORT_TABLES.has(name.toLowerCase())) return true;
  return false;
}

/** Extract SQL-ish string / template literal bodies from source. */
export function extractSqlFragments(source) {
  const out = [];
  // template literals
  const tpl = /`([^`\\]|\\.)*`/gs;
  let m;
  while ((m = tpl.exec(source))) {
    const body = m[0].slice(1, -1);
    if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/i.test(body)) out.push(body);
  }
  // single / double quoted strings spanning one line (common for short SQL)
  const q = /(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = q.exec(source))) {
    const body = m[2];
    if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/i.test(body)) out.push(body);
  }
  return out;
}

export function extractUsedTables(source) {
  const used = new Set();
  const patterns = [FROM_RE, INTO_RE, JOIN_RE, DELETE_RE, UPDATE_RE];
  for (const frag of extractSqlFragments(source)) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(frag))) {
        const name = m[1];
        if (looksLikeTableName(name)) used.add(name);
      }
    }
  }
  return used;
}

export function extractCreatedTables(sql) {
  const created = new Set();
  const cleaned = stripSqlComments(sql);
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(cleaned))) {
    const name = m[1];
    if (name && name.toUpperCase() !== "IF") created.add(name);
  }
  return created;
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

export function scanRepo(root) {
  const used = new Set();
  const created = new Set();
  for (const d of CODE_DIRS) {
    const abs = path.join(root, d);
    if (!existsSync(abs)) continue;
    const files = [];
    walk(abs, files);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const t of extractUsedTables(src)) used.add(t);
    }
  }
  const mig = path.join(root, "migrations");
  if (existsSync(mig)) {
    for (const fn of readdirSync(mig)) {
      if (!fn.endsWith(".sql")) continue;
      for (const t of extractCreatedTables(readFileSync(path.join(mig, fn), "utf8"))) {
        created.add(t);
      }
    }
  }
  const missing = [...used].filter((t) => !created.has(t)).sort();
  return { used: [...used].sort(), created: [...created].sort(), missing };
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (!Array.isArray(raw)) throw new Error("allowlist must be a JSON array of table names");
  for (const t of raw) {
    if (typeof t !== "string" || !t) throw new Error("allowlist entries must be non-empty strings");
  }
  return new Set(raw);
}

function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "sandy-schema-cov-"));
  try {
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "migrations"), { recursive: true });
    writeFileSync(
      path.join(root, "lib", "sample.ts"),
      [
        "const q = `SELECT id FROM tax_classes WHERE active = 1`;",
        'const u = "UPDATE products SET name = ?";',
        "const junk = `FROM Cart WHERE TipTap`;", // PascalCase filtered
        "const env = `SELECT ${DB_PASSWORD} FROM dual`;",
        "",
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(root, "migrations", "0001.sql"),
      "CREATE TABLE IF NOT EXISTS products (id INT);\n",
      "utf8"
    );
    const { used, created, missing } = scanRepo(root);
    if (!used.includes("tax_classes") || !used.includes("products")) {
      console.error("self-test FAIL: expected used tables", used);
      return EXIT_FAIL;
    }
    if (!created.includes("products")) {
      console.error("self-test FAIL: expected created products", created);
      return EXIT_FAIL;
    }
    if (!missing.includes("tax_classes") || missing.includes("products")) {
      console.error("self-test FAIL: unexpected missing", missing);
      return EXIT_FAIL;
    }
    // After adding migration, missing should shrink
    writeFileSync(
      path.join(root, "migrations", "0012.sql"),
      "CREATE TABLE IF NOT EXISTS tax_classes (id INT);\n",
      "utf8"
    );
    const after = scanRepo(root);
    if (after.missing.includes("tax_classes")) {
      console.error("self-test FAIL: tax_classes still missing after create", after.missing);
      return EXIT_FAIL;
    }
    console.log("check-schema-coverage --self-test OK");
    return EXIT_OK;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  let allow;
  try {
    allow = loadAllowlist();
  } catch (err) {
    console.error(`check-schema-coverage: cannot read allowlist: ${err.message}`);
    return EXIT_USAGE;
  }

  const { used, created, missing } = scanRepo(repoRoot);
  const reportable = missing.filter((t) => !allow.has(t));

  console.log(`check-schema-coverage: used=${used.length} created=${created.length} missing=${missing.length} reportable=${reportable.length}`);
  if (reportable.length > 0) {
    console.error("FAIL: tables used by code but not created by any migrations/*.sql:");
    for (const t of reportable) console.error(`  ${t}`);
    return EXIT_FAIL;
  }
  console.log("OK: schema coverage complete (allowlist empty or all covered).");
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
