/**
 * Secrets gate tuning (BATCH-12 H2): obvious test placeholders are not flagged,
 * realistic credentials still are. Fixtures for positives are built by concatenation
 * so this file itself stays clean under the gate.
 *
 * Run: node --test tests/secrets-gate.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "qa", "secrets-gate.mjs");

const gate = (await import(pathToFileURL(scriptPath).href)) as {
  buildPatterns: () => unknown[];
  scanContent: (file: string, text: string, patterns: unknown[]) => { patternId: string; line: number }[];
  isKnownPlaceholderValue: (v: string) => boolean;
};

const patterns = gate.buildPatterns();
const assignFindings = (text: string) =>
  gate.scanContent("fixture.txt", text, patterns).filter((f) => f.patternId === "secret_assignment");
const assign = (name: string, value: string) => `${name}: "${value}"`;

describe("secrets-gate secret_assignment tuning", () => {
  it("does not flag the BATCH-10 literal and other known test placeholders", () => {
    assert.equal(assignFindings('{ token: "not-a-token" }').length, 0);
    for (const v of ["not-a-real-token", "test", "dummy", "placeholder", "changeme", "<your-token>", "${API_TOKEN}", "your-api-key-here", "xxxxxxxx"]) {
      assert.equal(assignFindings(assign("token", v)).length, 0, `placeholder flagged: ${v}`);
    }
    assert.equal(assignFindings(assign("password", "TEST")).length, 0, "case-insensitive");
  });

  it("still flags realistic API keys and passwords", () => {
    const pw = "pass" + "word";
    const real: [string, string][] = [
      [pw, "Rbac-Db-Staff-Pass-1!x"],
      [pw, "Fire" + "stick@2026"],
      ["api_key", "f3a9c1e07b2d44859a6c0d1e2f3a4b5c"],
      ["secret", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      ["token", "9fK2xQvL8mPzTr4Wn7Yb"],
      ["db_pass", "Sup3r$ecretDbPw!"],
      // Placeholder words only exempt when they are the WHOLE value.
      ["token", "test-9fK2xQvL8mPz"],
      ["token", "not-a-token-9fK2xQvL8mPz"],
      ["secret", "dummy-live-4f8a9c2e7b1d"],
    ];
    for (const [name, value] of real) {
      assert.equal(assignFindings(assign(name, value)).length, 1, `real-looking value not flagged: ${name}`);
    }
  });

  it("mixed line: placeholder skipped, real value on same line still flagged", () => {
    const line = `{ token: "not-a-token", ${"pass" + "word"}: "Zq8!rT2#vLp9xK" }`;
    assert.equal(assignFindings(line).length, 1);
  });

  it("other patterns are unaffected (private key, AWS, JWT, URL creds)", () => {
    const text = [
      ["---", "--BEGIN", " PRIVATE", " KEY-----"].join(""),
      ["AK", "IA", "IOSFODNN7EXAMPLE"].join(""),
      ["eyJ", "hbGciOi", ".", "eyJ", "sub", ".", "sig"].join(""),
      ["https://", "user", ":", "pw0rd", "@example.com/x"].join(""),
    ].join("\n");
    const ids = new Set(gate.scanContent("f.txt", text, patterns).map((f) => f.patternId));
    for (const id of ["private_key_begin", "aws_access_key_id", "jwt_shaped", "url_embedded_credentials"]) {
      assert.ok(ids.has(id), `missing ${id}`);
    }
  });

  it("tests/accounts-db.test.mjs keeps the plain literal and is not flagged", () => {
    const src = readFileSync(path.join(repoRoot, "tests", "accounts-db.test.mjs"), "utf8");
    assert.ok(src.includes('token: "not-a-token"'));
    assert.equal(assignFindings(src).length, 0);
  });

  it("--self-test exits 0", () => {
    const r = spawnSync(process.execPath, [scriptPath, "--self-test"], { encoding: "utf8", cwd: repoRoot });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /self-test: (\d+)\/\1 passed/);
  });
});
