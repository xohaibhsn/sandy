import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("BATCH-58 static checks", () => {
  it("blog page has no hard-coded fallback posts", () => {
    const src = fs.readFileSync(path.join(root, "app/blog/page.tsx"), "utf8");
    assert.equal(/How to Shop on S&Y/.test(src), false);
    assert.equal(/id:\s*1,\s*featured:\s*true/.test(src), false);
    assert.equal(/blog_empty/.test(src), true);
  });

  it("og-default.svg has no Firestick/IPTV/UK leftover brand text", () => {
    const src = fs.readFileSync(path.join(root, "public/og-default.svg"), "utf8");
    assert.equal(/Firestick/i.test(src), false);
    assert.equal(/IPTV/i.test(src), false);
    assert.equal(/FIRESTICK4UK/i.test(src), false);
    assert.equal(/S&amp;Y/.test(src) || /S&Y/.test(src), true);
  });

  it("public/uploads has no .webp leftovers", () => {
    const dir = path.join(root, "public/uploads");
    const webps = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".webp"))
      : [];
    assert.equal(webps.length, 0, webps.join(","));
  });

  it("layout has no console.log site-assets", () => {
    const src = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
    assert.equal(/console\.log\(\s*\[site-assets\]/.test(src), false);
    assert.equal(/console\.log/.test(src), false);
  });
});
