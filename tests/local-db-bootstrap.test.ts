/**
 * Unit tests for scripts/qa/local-db-bootstrap.mjs guards (no network / no DB).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "qa", "local-db-bootstrap.mjs");

describe("local-db-bootstrap guards", () => {
  it("self-test exits 0", () => {
    const r = spawnSync(process.execPath, [script, "--self-test"], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });

  it("refuses non-local host and production-like db names", async () => {
    const mod = await import(pathToFileURL(script).href);
    assert.ok(mod.guardLocalOnly({ host: "sandy.com.pk", port: 3307, database: "sandy_local_x" }));
    assert.ok(mod.guardLocalOnly({ host: "127.0.0.1", port: 3307, database: "u992747032_sandy" }));
    assert.ok(mod.guardLocalOnly({ host: "127.0.0.1", port: 3306, database: "sandy_local_x" }));
    assert.equal(
      mod.guardLocalOnly({ host: "127.0.0.1", port: 3307, database: "sandy_local_b53" }),
      null
    );
  });

  it("CLI refusal for non-local host exits 2 before connecting", () => {
    const r = spawnSync(
      process.execPath,
      [
        script,
        "--host",
        "sandy.com.pk",
        "--port",
        "3307",
        "--user",
        "x",
        "--password",
        "y",
        "--database",
        "sandy_local_x",
      ],
      { encoding: "utf8", cwd: repoRoot }
    );
    assert.equal(r.status, 2, r.stderr || r.stdout);
    assert.match(r.stderr || r.stdout, /refusing non-local host/i);
  });

  it("CLI refusal for non-sandy_local db exits 2", () => {
    const r = spawnSync(
      process.execPath,
      [
        script,
        "--host",
        "127.0.0.1",
        "--port",
        "3307",
        "--user",
        "x",
        "--password",
        "y",
        "--database",
        "u992747032_sandy",
      ],
      { encoding: "utf8", cwd: repoRoot }
    );
    assert.equal(r.status, 2, r.stderr || r.stdout);
    assert.match(r.stderr || r.stdout, /sandy_local/i);
  });
});
