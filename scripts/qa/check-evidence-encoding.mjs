#!/usr/bin/env node
/**
 * sandy-qa check-evidence-encoding — byte-level pre-zip evidence gate (D36).
 *
 * Walks a folder recursively. For every .txt/.md/.json/.log/.tsv/.csv/.patch/.sql
 * file, reads RAW bytes and flags:
 *   - UTF-16LE BOM (FF FE)
 *   - UTF-16BE BOM (FE FF)
 *   - UTF-8 BOM (EF BB BF)
 *   - any NUL (0x00) byte
 * Also flags .js/.mjs/.cjs/.ts/.tsx/.py/.ps1/.sh as SOURCE_IN_EVIDENCE.
 *
 * Usage: node scripts/qa/check-evidence-encoding.mjs <folder> [--fix]
 * Exit: 0 = clean, 1 = offenders remain, 2 = usage/runtime error.
 *
 * --fix rewrites UTF-16 / UTF-8-BOM text files as UTF-8 without BOM, then rescans.
 * Source files are never rewritten (remove them by hand).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".json",
  ".log",
  ".tsv",
  ".csv",
  ".patch",
  ".sql",
]);
const SOURCE_EXT = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".ps1",
  ".sh",
]);

const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

function usage(code = EXIT_USAGE) {
  console.error(
    "Usage: node scripts/qa/check-evidence-encoding.mjs <folder> [--fix]\n\n" +
      "Byte-level scan of evidence files for UTF-16 / UTF-8 BOM / NUL bytes and source files.\n" +
      "Exit: 0=clean, 1=offenders, 2=usage/runtime error."
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { folder: null, fix: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--fix") out.fix = true;
    else if (a.startsWith("-")) usage();
    else if (out.folder == null) out.folder = a;
    else usage();
  }
  return out;
}

function walkFiles(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read ${root}: ${err.message}`);
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === ".git" || ent.name === "node_modules") continue;
      walkFiles(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function hasPrefix(buf, prefix) {
  if (buf.length < prefix.length) return false;
  return prefix.compare(buf, 0, prefix.length, 0, prefix.length) === 0;
}

function hasNul(buf) {
  return buf.includes(0x00);
}

/**
 * Classify a text evidence file from raw bytes.
 * Returns { kinds: string[], encodingHint } where kinds subset of UTF16|UTF8_BOM|NUL.
 */
function classifyText(buf) {
  const kinds = [];
  let encodingHint = "utf8";
  if (hasPrefix(buf, BOM_UTF16LE)) {
    kinds.push("UTF16");
    encodingHint = "utf16le";
  } else if (hasPrefix(buf, BOM_UTF16BE)) {
    kinds.push("UTF16");
    encodingHint = "utf16be";
  } else if (hasPrefix(buf, BOM_UTF8)) {
    kinds.push("UTF8_BOM");
    encodingHint = "utf8-bom";
  }
  if (hasNul(buf)) {
    // UTF-16 naturally contains NULs for ASCII; still count NUL separately
    // unless we already tagged UTF16 from BOM (still count NUL for totals).
    kinds.push("NUL");
  }
  return { kinds, encodingHint };
}

function decodeForFix(buf, encodingHint) {
  if (encodingHint === "utf16le") {
    return buf.slice(2).toString("utf16le");
  }
  if (encodingHint === "utf16be") {
    // Node has no utf16be; swap bytes then decode as utf16le.
    const body = buf.slice(2);
    const swapped = Buffer.alloc(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    if (body.length % 2 === 1) swapped[body.length - 1] = body[body.length - 1];
    return swapped.toString("utf16le");
  }
  if (encodingHint === "utf8-bom") {
    return buf.slice(3).toString("utf8");
  }
  // NUL without BOM: strip NULs is unsafe; leave unchanged (caller skips).
  return null;
}

function relDisplay(root, full) {
  return path.relative(root, full).split(path.sep).join("/");
}

function scanOnce(root) {
  const files = walkFiles(root);
  const offenders = [];
  let scanned = 0;
  let utf16 = 0;
  let utf8Bom = 0;
  let nul = 0;
  let source = 0;

  for (const full of files) {
    const ext = path.extname(full).toLowerCase();
    if (SOURCE_EXT.has(ext)) {
      scanned += 1;
      source += 1;
      offenders.push({
        path: relDisplay(root, full),
        full,
        kinds: ["SOURCE"],
        encodingHint: null,
      });
      continue;
    }
    if (!TEXT_EXT.has(ext)) continue;
    scanned += 1;
    let buf;
    try {
      buf = readFileSync(full);
    } catch (err) {
      throw new Error(`cannot read ${full}: ${err.message}`);
    }
    const { kinds, encodingHint } = classifyText(buf);
    if (kinds.length === 0) continue;
    if (kinds.includes("UTF16")) utf16 += 1;
    if (kinds.includes("UTF8_BOM")) utf8Bom += 1;
    if (kinds.includes("NUL")) nul += 1;
    offenders.push({
      path: relDisplay(root, full),
      full,
      kinds,
      encodingHint,
    });
  }

  return { scanned, utf16, utf8Bom, nul, source, offenders };
}

function printScan(result) {
  for (const o of result.offenders) {
    console.log(`${o.path}: ${o.kinds.join(",")}`);
  }
  console.log(`SCANNED=${result.scanned}`);
  console.log(`UTF16=${result.utf16}`);
  console.log(`UTF8_BOM=${result.utf8Bom}`);
  console.log(`NUL=${result.nul}`);
  console.log(`SOURCE=${result.source}`);
}

function applyFixes(root, offenders) {
  let fixed = 0;
  for (const o of offenders) {
    if (o.kinds.includes("SOURCE")) continue;
    if (!o.encodingHint || o.encodingHint === "utf8") continue;
    const buf = readFileSync(o.full);
    const text = decodeForFix(buf, o.encodingHint);
    if (text == null) continue;
    writeFileSync(o.full, text, { encoding: "utf8" });
    fixed += 1;
    console.log(`FIXED ${relDisplay(root, o.full)} (${o.encodingHint} -> utf8)`);
  }
  return fixed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (!args.folder) usage();

  const root = path.resolve(args.folder);
  let st;
  try {
    st = statSync(root);
  } catch (err) {
    console.error(`error: folder not found: ${root}`);
    process.exit(EXIT_USAGE);
  }
  if (!st.isDirectory()) {
    console.error(`error: not a directory: ${root}`);
    process.exit(EXIT_USAGE);
  }

  let result = scanOnce(root);
  if (args.fix && result.offenders.length > 0) {
    const n = applyFixes(root, result.offenders);
    console.log(`FIX_PASS rewritten=${n}`);
    result = scanOnce(root);
  }

  printScan(result);
  const dirty =
    result.utf16 + result.utf8Bom + result.nul + result.source > 0 ||
    result.offenders.length > 0;
  process.exit(dirty ? EXIT_FAIL : EXIT_OK);
}

main();
