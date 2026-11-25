/**
 * Unit tests for scripts/qa/check-schema-coverage.mjs (fixture repo dirs; no network).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "qa", "check-schema-coverage.mjs");

describe("check-schema-coverage", () => {
  it("self-test exits 0", () => {
    const r = spawnSync(process.execPath, [script, "--self-test"], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });

  it("extracts used vs created from a fixture repo", async () => {
    const mod = await import(pathToFileURL(script).href);
    const root = mkdtempSync(path.join(tmpdir(), "sandy-cov-unit-"));
    try {
      mkdirSync(path.join(root, "lib"), { recursive: true });
      mkdirSync(path.join(root, "migrations"), { recursive: true });
      writeFileSync(
        path.join(root, "lib", "q.ts"),
        "export const q = `SELECT * FROM order_tax_snapshots WHERE order_id = ?`;\n",
        "utf8"
      );
      writeFileSync(
        path.join(root, "migrations", "0001.sql"),
        "CREATE TABLE IF NOT EXISTS products (id INT);\n",
        "utf8"
      );
      const before = mod.scanRepo(root);
      assert.ok(before.missing.includes("order_tax_snapshots"));
      writeFileSync(
        path.join(root, "migrations", "0012.sql"),
        "CREATE TABLE IF NOT EXISTS order_tax_snapshots (order_id VARCHAR(64));\n",
        "utf8"
      );
      const after = mod.scanRepo(root);
      assert.ok(!after.missing.includes("order_tax_snapshots"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
