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
