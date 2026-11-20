/**
 * BATCH-25 — TOKEN + MOJIBAKE + EXIT coverage for check-evidence-encoding (folder + --zip).
 *
 * Fixture values are built at runtime from parts so the repo never contains literal tokens.
 * Run: node --test tests/qa-evidence-scan.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "qa", "check-evidence-encoding.mjs");

/** Runtime-built token-like fixtures (never stored as contiguous literals in source). */
function fixtures() {
  const pad = (n: number, ch = "a") => ch.repeat(n);
  return {
    crsr: ["crsr_", pad(24, "A")].join(""),
    sk: ["sk-", pad(24, "b")].join(""),
    ghp: ["ghp_", pad(24, "c")].join(""),
    github_pat: ["github_pat_", pad(24, "d")].join(""),
    akia: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""), // 4 + 16
    xox: ["xoxb-", "1234567890abcdef"].join(""),
    api_key_flag: ["--api-key", " ", pad(12, "e")].join(""),
    bearer: ["Bearer", " ", pad(24, "f")].join(""),
    private_key: ["-----", "BEGIN", " ", "RSA", " ", "PRIVATE", " ", "KEY", "-----"].join(""),
    mysql_url: ["mysql://", "u", ":", "p", "@", "h"].join(""),
    twilio_sk: ["SK", "0123456789abcdef0123456789abcdef"].join(""),
    mojibake: ["bad ", "\u00e2\u20ac", " tick"].join(""),
    placeholder: "[SECRET - ask Professor]",
  };
}

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

function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data, "utf8");
    const deflate = (s.method ?? "store") === "deflate";
    const body = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(s.name, "utf8");
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
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

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

function lastExitLine(stdout: string) {
  const lines = stdout.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return lines[lines.length - 1] || "";
}

function getTotal(stdout: string, key: string) {
  const m = stdout.match(new RegExp(`^${key}=(\\d+)$`, "m"));
  assert.ok(m, `missing ${key} in:\n${stdout}`);
  return Number(m[1]);
}

describe("qa-evidence-scan TOKEN + MOJIBAKE + EXIT", () => {
  let root: string;
  let fx: ReturnType<typeof fixtures>;
  const tokenIds = [
    "crsr",
    "sk",
    "ghp",
    "github_pat",
    "akia",
    "xox",
    "api_key_flag",
    "bearer",
    "private_key",
    "mysql_url",
    "twilio_sk",
  ] as const;

  before(() => {
    fx = fixtures();
    root = mkdtempSync(path.join(tmpdir(), "sandy-qa-scan-"));
    writeFileSync(path.join(root, "clean.txt"), "all clear\n", "utf8");
    writeFileSync(path.join(root, "placeholder.txt"), `${fx.placeholder}\n`, "utf8");
    writeFileSync(path.join(root, "mojibake.txt"), `${fx.mojibake}\n`, "utf8");
    for (const id of tokenIds) {
      writeFileSync(path.join(root, `tok-${id}.txt`), `${fx[id]}\n`, "utf8");
    }
    const zipBuf = makeZip([
      { name: "nested/tok.txt", data: `${fx.crsr}\n`, method: "store" },
      { name: "nested/moji.txt", data: `${fx.mojibake}\n`, method: "store" },
    ]);
    writeFileSync(path.join(root, "sample.zip"), zipBuf);
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("folder mode: TOKEN + MOJIBAKE counts, exit 1, no token text echoed, EXIT last", () => {
    const r = run([root]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const out = r.stdout;
    assert.equal(lastExitLine(out), "EXIT 1");
    assert.equal(getTotal(out, "TOKEN"), tokenIds.length);
    assert.ok(getTotal(out, "MOJIBAKE") >= 1);
    assert.equal(getTotal(out, "UTF16"), 0);
    assert.equal(getTotal(out, "SOURCE"), 0);
    for (const id of tokenIds) {
      assert.match(out, new RegExp(`tok-${id}\\.txt:1: TOKEN\\(${id}\\)`));
      // Never echo the fixture token text itself
      assert.ok(!out.includes(fx[id]), `stdout leaked token fixture for ${id}`);
    }
    assert.match(out, /mojibake\.txt:1: MOJIBAKE/);
    assert.doesNotMatch(out, /placeholder\.txt:.*TOKEN/);
    assert.ok(!out.includes(fx.mojibake) || out.includes("MOJIBAKE")); // mojibake marker may appear in path lines only as MOJIBAKE label
  });

  it("folder mode clean file alone exits 0 with TOKEN=0 MOJIBAKE=0 and EXIT 0", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "sandy-qa-clean-"));
    try {
      writeFileSync(path.join(clean, "ok.md"), "fine\n", "utf8");
      writeFileSync(path.join(clean, "ph.txt"), `${fx.placeholder}\n`, "utf8");
      writeFileSync(path.join(clean, "red.txt"), "token [REDACTED_VALUE] kept\n", "utf8");
      const r = run([clean]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(lastExitLine(r.stdout), "EXIT 0");
      assert.equal(getTotal(r.stdout, "TOKEN"), 0);
      assert.equal(getTotal(r.stdout, "MOJIBAKE"), 0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("--zip mode: ZIP_TOKEN + ZIP_MOJIBAKE, exit 1, no token text, EXIT last", () => {
    const z = path.join(root, "sample.zip");
    const r = run(["--zip", z]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const out = r.stdout;
    assert.equal(lastExitLine(out), "EXIT 1");
    assert.ok(getTotal(out, "ZIP_TOKEN") >= 1);
    assert.ok(getTotal(out, "ZIP_MOJIBAKE") >= 1);
    assert.match(out, /nested\/tok\.txt:1: TOKEN\(crsr\)/);
    assert.match(out, /nested\/moji\.txt:1: MOJIBAKE/);
    assert.ok(!out.includes(fx.crsr), "zip stdout leaked crsr fixture");
  });

  it("--fix does not clear TOKEN hits", () => {
    const dirty = mkdtempSync(path.join(tmpdir(), "sandy-qa-fix-"));
    try {
      writeFileSync(path.join(dirty, "tok.txt"), `${fx.sk}\n`, "utf8");
      const r = run([dirty, "--fix"]);
      assert.equal(r.status, 1, r.stderr || r.stdout);
      assert.equal(getTotal(r.stdout, "TOKEN"), 1);
      assert.match(r.stdout, /tok\.txt:1: TOKEN\(sk\)/);
      assert.equal(lastExitLine(r.stdout), "EXIT 1");
      assert.ok(!r.stdout.includes(fx.sk));
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });
});
