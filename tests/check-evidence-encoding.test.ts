/**
 * Evidence encoding gate (BATCH-10 / D36) — unit test with runtime temp fixtures.
 *
 * Covers detection of UTF-16LE, UTF-16BE, UTF-8 BOM, NUL, clean UTF-8, and
 * SOURCE_IN_EVIDENCE (.mjs), plus exit codes and --fix rewrite behaviour.
 *
 * Run: node --test tests/check-evidence-encoding.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "qa", "check-evidence-encoding.mjs");

function run(folder: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [script, folder, ...extraArgs], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

function parseTotals(stdout: string) {
  const get = (k: string) => {
    const m = stdout.match(new RegExp(`^${k}=(\\d+)$`, "m"));
    assert.ok(m, `missing ${k} in output:\n${stdout}`);
    return Number(m[1]);
  };
  return {
    SCANNED: get("SCANNED"),
    UTF16: get("UTF16"),
    UTF8_BOM: get("UTF8_BOM"),
    NUL: get("NUL"),
    SOURCE: get("SOURCE"),
  };
}

describe("check-evidence-encoding", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "sandy-enc-"));
    const sub = path.join(root, "nested");
    mkdirSync(sub, { recursive: true });

    // Clean UTF-8 (no BOM, no NUL)
    writeFileSync(path.join(root, "clean.txt"), "hello clean utf8\n", "utf8");

    // UTF-16LE with BOM
    writeFileSync(
      path.join(root, "le.md"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("le-body", "utf16le")])
    );

    // UTF-16BE with BOM
    const beBody = Buffer.from("be-body", "utf16le");
    const beSwapped = Buffer.alloc(beBody.length);
    for (let i = 0; i + 1 < beBody.length; i += 2) {
      beSwapped[i] = beBody[i + 1];
      beSwapped[i + 1] = beBody[i];
    }
    writeFileSync(
      path.join(root, "be.json"),
      Buffer.concat([Buffer.from([0xfe, 0xff]), beSwapped])
    );

    // UTF-8 BOM
    writeFileSync(
      path.join(sub, "bom.log"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom-body", "utf8")])
    );

    // NUL byte without BOM
    writeFileSync(path.join(root, "nul.csv"), Buffer.from([0x61, 0x00, 0x62]));

    // Source file in evidence
    writeFileSync(path.join(root, "helper.mjs"), "export const x = 1;\n", "utf8");
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("detects UTF-16LE/BE, UTF-8 BOM, NUL, and SOURCE; exits 1", () => {
    const r = run(root);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const out = r.stdout;
    assert.match(out, /le\.md: UTF16,NUL/);
    assert.match(out, /be\.json: UTF16,NUL/);
    assert.match(out, /nested\/bom\.log: UTF8_BOM|nested\\bom\.log: UTF8_BOM/);
    assert.match(out, /nul\.csv: NUL/);
    assert.match(out, /helper\.mjs: SOURCE/);
    const t = parseTotals(out);
    assert.equal(t.UTF16, 2);
    assert.equal(t.UTF8_BOM, 1);
    assert.ok(t.NUL >= 3, `expected NUL>=3 got ${t.NUL}`);
    assert.equal(t.SOURCE, 1);
    assert.ok(t.SCANNED >= 6);
  });

  it("--fix rewrites BOM/UTF-16 text files to UTF-8 without BOM; source remains", () => {
    const r = run(root, ["--fix"]);
    // Still fails because helper.mjs + possibly nul.csv remain
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /FIX_PASS rewritten=/);

    const le = readFileSync(path.join(root, "le.md"));
    assert.equal(le[0], 0x6c); // 'l' of le-body — no BOM
    assert.ok(!le.includes(0x00));
    assert.equal(le.toString("utf8"), "le-body");

    const be = readFileSync(path.join(root, "be.json"));
    assert.ok(!be.includes(0x00));
    assert.ok(!(be[0] === 0xfe && be[1] === 0xff));
    assert.equal(be.toString("utf8"), "be-body");

    const bom = readFileSync(path.join(root, "nested", "bom.log"));
    assert.ok(!(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf));
    assert.equal(bom.toString("utf8"), "bom-body");

    // Source never rewritten
    assert.equal(readFileSync(path.join(root, "helper.mjs"), "utf8"), "export const x = 1;\n");

    // NUL-only file is not auto-fixed (no BOM / UTF-16 hint)
    const nul = readFileSync(path.join(root, "nul.csv"));
    assert.ok(nul.includes(0x00));

    const t = parseTotals(r.stdout);
    assert.equal(t.UTF16, 0);
    assert.equal(t.UTF8_BOM, 0);
    assert.equal(t.SOURCE, 1);
    assert.ok(t.NUL >= 1);
  });

  it("exits 0 on a clean folder", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "sandy-enc-clean-"));
    try {
      writeFileSync(path.join(clean, "ok.md"), "all good\n", "utf8");
      writeFileSync(path.join(clean, "ok.json"), "{\"a\":1}\n", "utf8");
      const r = run(clean);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const t = parseTotals(r.stdout);
      assert.equal(t.UTF16, 0);
      assert.equal(t.UTF8_BOM, 0);
      assert.equal(t.NUL, 0);
      assert.equal(t.SOURCE, 0);
      assert.equal(t.SCANNED, 2);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});

/* ---------------- --zip mode (BATCH-12 H3) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type ZipSpec = { name: string; data: Buffer | string; method?: "store" | "deflate" };

/** Build a ZIP in memory (stored or deflated entries), arcnames written verbatim (backslashes allowed). */
function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data, "utf8");
    const deflate = (s.method ?? "deflate") === "deflate";
    const body = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(s.name, "utf8");
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6); // UTF-8 names
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, body]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));

    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function runArgs(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot });
}

function parseZipTotals(stdout: string) {
  const get = (k: string) => {
    const m = stdout.match(new RegExp(`^ZIP_${k}=(\\d+)$`, "m"));
    assert.ok(m, `missing ZIP_${k} in output:\n${stdout}`);
    return Number(m[1]);
  };
  return {
    SCANNED: get("SCANNED"),
    BACKSLASH: get("BACKSLASH"),
    UTF16: get("UTF16"),
    UTF8_BOM: get("UTF8_BOM"),
    NUL: get("NUL"),
    SOURCE: get("SOURCE"),
    UNREADABLE: get("UNREADABLE"),
    OUTSIDE_FOLDER: get("OUTSIDE_FOLDER"),
  };
}

describe("check-evidence-encoding --zip", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandy-zip-"));
  });
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function zipFile(name: string, specs: ZipSpec[], where = dir) {
    mkdirSync(where, { recursive: true });
    const p = path.join(where, name);
    writeFileSync(p, makeZip(specs));
    return p;
  }

  it("passes a clean zip (deflated + stored entries, forward-slash arcnames)", () => {
    const z = zipFile("clean.zip", [
      { name: "evidence/report.md", data: "# ok\n" },
      { name: "evidence/data.json", data: '{"a":1}\n', method: "store" },
      { name: "evidence/img.png", data: Buffer.from([0x89, 0x50, 0x00, 0x01]) }, // binary ext not scanned
      { name: "evidence/", data: "", method: "store" },
    ]);
    const r = runArgs(["--zip", z]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const t = parseZipTotals(r.stdout);
    assert.deepEqual(t, { SCANNED: 4, BACKSLASH: 0, UTF16: 0, UTF8_BOM: 0, NUL: 0, SOURCE: 0, UNREADABLE: 0, OUTSIDE_FOLDER: 0 });
  });

  it("fails on a backslash arcname", () => {
    const z = zipFile("backslash.zip", [
      { name: "evidence\\win.txt", data: "hello\n" },
      { name: "evidence/ok.txt", data: "fine\n" },
    ]);
    const r = runArgs(["--zip", z]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /evidence\\win\.txt: BACKSLASH/);
    assert.equal(parseZipTotals(r.stdout).BACKSLASH, 1);
  });

  it("fails on source-extension entries", () => {
    for (const ext of ["js", "mjs", "cjs", "ts", "tsx", "py", "ps1", "sh"]) {
      const z = zipFile(`src-${ext}.zip`, [{ name: `evidence/helper.${ext}`, data: "x\n" }]);
      const r = runArgs(["--zip", z]);
      assert.equal(r.status, 1, `.${ext}: ${r.stderr || r.stdout}`);
      assert.match(r.stdout, new RegExp(`helper\\.${ext}: SOURCE`));
      assert.equal(parseZipTotals(r.stdout).SOURCE, 1);
    }
  });

  it("fails on UTF-16LE/BE BOM, UTF-8 BOM, and NUL in text entries (inflated before checking)", () => {
    const z = zipFile("encoding.zip", [
      { name: "le.md", data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("le", "utf16le")]) },
      { name: "be.json", data: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x62])]), method: "store" },
      { name: "sub/bom.log", data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom")]) },
      { name: "nul.csv", data: Buffer.from([0x61, 0x00, 0x62]) },
      { name: "clean.txt", data: "clean\n" },
    ]);
    const r = runArgs(["--zip", z]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /le\.md: UTF16,NUL/);
    assert.match(r.stdout, /be\.json: UTF16,NUL/);
    assert.match(r.stdout, /sub\/bom\.log: UTF8_BOM/);
    assert.match(r.stdout, /nul\.csv: NUL/);
    assert.doesNotMatch(r.stdout, /clean\.txt:/);
    const t = parseZipTotals(r.stdout);
    assert.equal(t.UTF16, 2);
    assert.equal(t.UTF8_BOM, 1);
    assert.equal(t.NUL, 3);
    assert.equal(t.SCANNED, 5);
  });

  it("with a folder arg: passes when the zip is inside the folder", () => {
    const folder = path.join(dir, "bundle");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "ok.md"), "fine\n", "utf8");
    const z = zipFile("inside.zip", [{ name: "ok.md", data: "fine\n" }], folder);
    const r = runArgs([folder, "--zip", z]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(parseZipTotals(r.stdout).OUTSIDE_FOLDER, 0);
    assert.equal(parseTotals(r.stdout).SCANNED, 1); // folder scan still runs; zip ext not scanned
  });

  it("with a folder arg: fails when the zip is outside the folder", () => {
    const folder = path.join(dir, "bundle2");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "ok.md"), "fine\n", "utf8");
    const z = zipFile("outside.zip", [{ name: "ok.md", data: "fine\n" }]); // in `dir`, not `folder`
    const r = runArgs([folder, "--zip", z]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /outside\.zip: ZIP_OUTSIDE_FOLDER/);
    assert.equal(parseZipTotals(r.stdout).OUTSIDE_FOLDER, 1);
  });

  it("a sibling folder with a shared name prefix does not count as inside", () => {
    const folder = path.join(dir, "ev");
    const sibling = path.join(dir, "ev-other");
    mkdirSync(folder, { recursive: true });
    const z = zipFile("prefix.zip", [{ name: "a.md", data: "x\n" }], sibling);
    const r = runArgs([folder, "--zip", z]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    assert.equal(parseZipTotals(r.stdout).OUTSIDE_FOLDER, 1);
  });

  it("folder scan alone is unchanged (no ZIP_ lines) and folder offenders still fail alongside a clean zip", () => {
    const folder = path.join(dir, "bundle3");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "bad.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    const noZip = runArgs([folder]);
    assert.equal(noZip.status, 1);
    assert.doesNotMatch(noZip.stdout, /ZIP_/);
    const z = zipFile("clean3.zip", [{ name: "ok.md", data: "ok\n" }], folder);
    const r = runArgs([folder, "--zip", z]);
    assert.equal(r.status, 1, "folder BOM must still fail");
    assert.match(r.stdout, /bad\.md: UTF8_BOM/);
  });

  it("usage/runtime errors exit 2: missing zip, non-zip file, --zip without value, --fix without folder", () => {
    assert.equal(runArgs(["--zip", path.join(dir, "nope.zip")]).status, 2);
    const notZip = path.join(dir, "notzip.zip");
    writeFileSync(notZip, "this is not a zip file at all, just text padding.....");
    assert.equal(runArgs(["--zip", notZip]).status, 2);
    assert.equal(runArgs(["--zip"]).status, 2);
    assert.equal(runArgs(["--zip", path.join(dir, "clean.zip"), "--fix"]).status, 2);
  });
});
