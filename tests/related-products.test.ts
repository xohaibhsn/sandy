import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  selectRelatedProducts,
  parseRelatedCms,
} = await import("../lib/relatedProducts.ts");
type RelatedProductRow = import("../lib/relatedProducts.ts").RelatedProductRow;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function row(
  partial: Partial<RelatedProductRow> & Pick<RelatedProductRow, "id" | "name" | "slug" | "category">
): RelatedProductRow {
  return {
    price: 100,
    image: null,
    badge: null,
    track_inventory: 0,
    stock_quantity: null,
    created_at: null,
    ...partial,
  };
}

describe("related products selector", () => {
  it("same category first, excludes current, no duplicates", () => {
    const current = { id: 10, category: "A" };
    const candidates = [
      row({ id: 9, name: "A9", slug: "a9", category: "A" }),
      row({ id: 8, name: "B8", slug: "b8", category: "B" }),
      row({ id: 7, name: "A7", slug: "a7", category: "A" }),
      row({ id: 10, name: "Self", slug: "self", category: "A" }),
      row({ id: 7, name: "Dup", slug: "dup", category: "A" }),
    ];
    const out = selectRelatedProducts(current, candidates, { count: 4, fill: true });
    const ids = out.map((p) => p.id);
    assert.equal(ids.includes(10), false);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.indexOf(9) < ids.indexOf(8) || !ids.includes(8) || ids.indexOf(9) >= 0);
    // first slots should be category A
    assert.equal(out[0].slug, "a9");
    assert.equal(out[1].slug, "a7");
  });

  it("out-of-stock last within same category", () => {
    const current = { id: 1, category: "A" };
    const candidates = [
      row({
        id: 5,
        name: "OOS",
        slug: "oos",
        category: "A",
        track_inventory: 1,
        stock_quantity: 0,
      }),
      row({
        id: 4,
        name: "In",
        slug: "in",
        category: "A",
        track_inventory: 1,
        stock_quantity: 3,
      }),
    ];
    const out = selectRelatedProducts(current, candidates, { count: 4, fill: false });
    assert.equal(out.length, 2);
    assert.equal(out[0].slug, "in");
    assert.equal(out[1].slug, "oos");
    assert.equal(out[1].outOfStock, true);
  });

  it("fill on pads with other categories; fill off does not", () => {
    const current = { id: 1, category: "B" };
    const candidates = [
      row({ id: 20, name: "B20", slug: "b20", category: "B" }),
      row({ id: 19, name: "B19", slug: "b19", category: "B" }),
      row({ id: 30, name: "A30", slug: "a30", category: "A" }),
      row({ id: 29, name: "A29", slug: "a29", category: "A" }),
    ];
    const filled = selectRelatedProducts(current, candidates, { count: 4, fill: true });
    assert.equal(filled.length, 4);
    assert.deepEqual(
      filled.map((p) => p.slug),
      ["b20", "b19", "a30", "a29"]
    );
    const noFill = selectRelatedProducts(current, candidates, { count: 4, fill: false });
    assert.equal(noFill.length, 2);
    assert.deepEqual(
      noFill.map((p) => p.slug),
      ["b20", "b19"]
    );
  });

  it("clamps count to 2–8", () => {
    const current = { id: 1, category: "A" };
    const candidates = Array.from({ length: 12 }, (_, i) =>
      row({ id: 100 - i, name: `P${i}`, slug: `p${i}`, category: "A" })
    );
    assert.equal(selectRelatedProducts(current, candidates, { count: 1, fill: false }).length, 2);
    assert.equal(selectRelatedProducts(current, candidates, { count: 99, fill: false }).length, 8);
    assert.equal(selectRelatedProducts(current, candidates, { count: 4, fill: false }).length, 4);
  });

  it("empty input yields empty", () => {
    assert.deepEqual(
      selectRelatedProducts({ id: 1, category: "A" }, [], { count: 4, fill: true }),
      []
    );
  });

  it("parseRelatedCms defaults and disable", () => {
    const d = parseRelatedCms({});
    assert.equal(d.enabled, true);
    assert.equal(d.title, "You may also like");
    assert.equal(d.count, 4);
    assert.equal(d.fill, true);
    const off = parseRelatedCms({
      product_related_enabled: "0",
      product_related_title: "ZZ Related",
      product_related_count: "2",
      product_related_fill: "0",
    });
    assert.equal(off.enabled, false);
    assert.equal(off.title, "ZZ Related");
    assert.equal(off.count, 2);
    assert.equal(off.fill, false);
  });
});

describe("related products static checks", () => {
  it("ProductDetail delivery pill fallback is Easy returns", () => {
    const src = fs.readFileSync(
      path.join(root, "app/products/[slug]/ProductDetail.tsx"),
      "utf8"
    );
    assert.match(src, /pdp_pill_delivery",\s*"Easy returns"/);
    assert.equal(/pdp_pill_delivery",\s*"Free delivery"/.test(src), false);
  });

  it("no Free delivery fallback string left in app/**", () => {
    const appDir = path.join(root, "app");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|jsx)$/.test(ent.name)) {
          const text = fs.readFileSync(p, "utf8");
          if (/Free delivery/.test(text)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(appDir);
    assert.deepEqual(hits, []);
  });

  it("pages/api/products.ts unchanged vs 648e6e0", () => {
    const out = execFileSync(
      "git",
      ["diff", "648e6e0c00578afe275c5960b54c902e5c7b346e", "--", "pages/api/products.ts"],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(out, "");
  });

  it("productLd object literal unchanged vs 648e6e0", () => {
    const extract = (src: string) => {
      const norm = src.replace(/\r\n/g, "\n");
      const start = norm.indexOf("const productLd = {");
      assert.ok(start >= 0, "productLd missing");
      const end = norm.indexOf("};", start);
      assert.ok(end > start);
      return norm.slice(start, end + 2);
    };
    const head = fs.readFileSync(path.join(root, "app/products/[slug]/page.tsx"), "utf8");
    const base = execFileSync(
      "git",
      ["show", "648e6e0c00578afe275c5960b54c902e5c7b346e:app/products/[slug]/page.tsx"],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(extract(head), extract(base));
  });
});
