/**
 * Assert checkout + contact phone placeholders are generic (not store contact).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function placeholders(src: string): string[] {
  const out: string[] = [];
  const re = /placeholder\s*[:=]\s*(\{[^}]+\}|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push(m[1]);
  }
  return out;
}

describe("phone placeholder (checkout + contact)", () => {
  const cart = readFileSync(path.join(ROOT, "app/cart/page.tsx"), "utf8");
  const contact = readFileSync(path.join(ROOT, "app/contact/page.tsx"), "utf8");

  it("does not use contact.phone as a placeholder", () => {
    for (const src of [cart, contact]) {
      for (const p of placeholders(src)) {
        assert.equal(p.includes("contact.phone"), false);
      }
    }
  });

  it("uses the generic sample placeholder on both forms", () => {
    assert.ok(cart.includes('placeholder:"03XX XXXXXXX"'));
    assert.ok(contact.includes('placeholder="03XX XXXXXXX"'));
  });

  it("has no literal 11-digit 03… or +923… in placeholder attributes", () => {
    for (const src of [cart, contact]) {
      for (const p of placeholders(src)) {
        assert.equal(/03\d{9}/.test(p), false);
        assert.equal(/\+923\d{9}/.test(p), false);
      }
    }
  });
});
