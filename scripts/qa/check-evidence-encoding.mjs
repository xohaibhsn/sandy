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
 *        node scripts/qa/check-evidence-encoding.mjs --zip <zipfile> [<folder>]
 * Exit: 0 = clean, 1 = offenders remain, 2 = usage/runtime error.
 *
 * --fix rewrites UTF-16 / UTF-8-BOM text files as UTF-8 without BOM, then rescans.
 * Source files are never rewritten (remove them by hand).
 *
 * --zip <zipfile> (post-zip gate, BATCH-12 H3) parses the ZIP central directory itself
 * (Node built-ins only: fs, zlib, path) and FAILS when:
 *   - any arcname contains a backslash (BACKSLASH)
 *   - any entry has a source extension .js .mjs .cjs .ts .tsx .py .ps1 .sh (SOURCE)
 *   - any text-extension entry has a UTF-16 / UTF-8 BOM or a NUL byte (UTF16/UTF8_BOM/NUL)
 *   - the entry cannot be read (encrypted / unsupported method / corrupt) (UNREADABLE)
 *   - a <folder> is also given and the ZIP file is not inside it (ZIP_OUTSIDE_FOLDER)
 * --fix never modifies a ZIP.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

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
    "Usage: node scripts/qa/check-evidence-encoding.mjs <folder> [--fix]\n" +
      "       node scripts/qa/check-evidence-encoding.mjs --zip <zipfile> [<folder>]\n\n" +
      "Byte-level scan of evidence files for UTF-16 / UTF-8 BOM / NUL bytes and source files.\n" +
      "Exit: 0=clean, 1=offenders, 2=usage/runtime error."
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { folder: null, fix: false, help: false, zip: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--fix") out.fix = true;
    else if (a === "--zip") {
      const v = argv[++i];
      if (!v || v.startsWith("-") || out.zip != null) usage();
      out.zip = v;
    }
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

/* ------------------------------------------------------------------ */
/* ZIP mode (--zip): minimal central-directory reader, Node built-ins  */
/* ------------------------------------------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/**
 * Parse a ZIP buffer into entries [{ name, method, flags, compSize, size, localOffset }].
 * ZIP64 and multi-disk archives are rejected (throws).
 */
function readZipEntries(buf) {
  const minEocd = 22;
  let eocd = -1;
  const lowest = Math.max(0, buf.length - (0xffff + minEocd));
  for (let i = buf.length - minEocd; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (end-of-central-directory not found)");

  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error("multi-disk ZIP is not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > eocd) throw new Error("corrupt ZIP (central directory out of range)");

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error("corrupt ZIP (bad central directory entry)");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error("corrupt ZIP (entry name out of range)");
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    // Bit 11 = UTF-8 names; otherwise legacy (latin1 is enough: we only look at ASCII markers).
    const name = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    entries.push({ name, flags, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Return the uncompressed bytes of an entry, or null when unreadable. */
function readZipEntryData(buf, e) {
  if (e.flags & 0x1) return null; // encrypted
  const lo = e.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) return null;
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const end = start + e.compSize;
  if (end > buf.length) return null;
  const raw = buf.subarray(start, end);
  try {
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return inflateRawSync(raw);
  } catch {
    return null;
  }
  return null; // unsupported method
}

function isInsideFolder(root, file) {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function scanZip(zipPath, folderRoot) {
  let st;
  try {
    st = statSync(zipPath);
  } catch {
    throw new Error(`zip not found: ${zipPath}`);
  }
  if (!st.isFile()) throw new Error(`not a file: ${zipPath}`);
  const buf = readFileSync(zipPath);
  const entries = readZipEntries(buf);

  const res = {
    zip: zipPath,
    scanned: 0,
    backslash: 0,
    utf16: 0,
    utf8Bom: 0,
    nul: 0,
    source: 0,
    unreadable: 0,
    outside: 0,
    offenders: [],
    dirty: false,
  };

  if (folderRoot && !isInsideFolder(folderRoot, zipPath)) {
    res.outside = 1;
    res.offenders.push({ path: path.basename(zipPath), kinds: ["ZIP_OUTSIDE_FOLDER"] });
  }

  for (const e of entries) {
    res.scanned += 1;
    const kinds = [];
    if (e.name.includes("\\")) {
      kinds.push("BACKSLASH");
      res.backslash += 1;
    }
    const ext = path.posix.extname(e.name.replace(/\\/g, "/")).toLowerCase();
    if (SOURCE_EXT.has(ext)) {
      kinds.push("SOURCE");
      res.source += 1;
    } else if (TEXT_EXT.has(ext)) {
      const data = readZipEntryData(buf, e);
      if (data === null) {
        kinds.push("UNREADABLE");
        res.unreadable += 1;
      } else {
        const c = classifyText(data);
        for (const k of c.kinds) kinds.push(k);
        if (c.kinds.includes("UTF16")) res.utf16 += 1;
        if (c.kinds.includes("UTF8_BOM")) res.utf8Bom += 1;
        if (c.kinds.includes("NUL")) res.nul += 1;
      }
    }
    if (kinds.length > 0) res.offenders.push({ path: e.name, kinds });
  }

  res.dirty = res.offenders.length > 0;
  return res;
}

function printZipScan(r) {
  for (const o of r.offenders) {
    console.log(`${o.path}: ${o.kinds.join(",")}`);
  }
  console.log(`ZIP_SCANNED=${r.scanned}`);
  console.log(`ZIP_BACKSLASH=${r.backslash}`);
  console.log(`ZIP_UTF16=${r.utf16}`);
  console.log(`ZIP_UTF8_BOM=${r.utf8Bom}`);
  console.log(`ZIP_NUL=${r.nul}`);
  console.log(`ZIP_SOURCE=${r.source}`);
  console.log(`ZIP_UNREADABLE=${r.unreadable}`);
  console.log(`ZIP_OUTSIDE_FOLDER=${r.outside}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(EXIT_OK);
  if (!args.folder && !args.zip) usage();
  if (args.fix && !args.folder) {
    console.error("error: --fix needs a <folder> (ZIP files are never modified)");
    process.exit(EXIT_USAGE);
  }

  let root = null;
  if (args.folder) {
    root = path.resolve(args.folder);
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
  }

  let dirty = false;

  if (root) {
    let result = scanOnce(root);
    if (args.fix && result.offenders.length > 0) {
      const n = applyFixes(root, result.offenders);
      console.log(`FIX_PASS rewritten=${n}`);
      result = scanOnce(root);
    }

    printScan(result);
    dirty =
      result.utf16 + result.utf8Bom + result.nul + result.source > 0 ||
      result.offenders.length > 0;
  }

  if (args.zip) {
    const zipPath = path.resolve(args.zip);
    let zipResult;
    try {
      zipResult = scanZip(zipPath, root);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(EXIT_USAGE);
    }
    printZipScan(zipResult);
    if (zipResult.dirty) dirty = true;
  }

  process.exit(dirty ? EXIT_FAIL : EXIT_OK);
}

main();
