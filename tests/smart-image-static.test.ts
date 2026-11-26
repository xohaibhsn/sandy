import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IN_SCOPE = [
  "app/HomeClient.tsx",
  "app/category/[slug]/CategoryClient.tsx",
  "app/products/ProductsClient.tsx",
  "app/products/[slug]/ProductDetail.tsx",
  "app/blog/[slug]/BlogPostClient.tsx",
  "components/blog/BlogListClient.tsx",
  "components/Navbar.tsx",
  "components/WhatsAppButton.tsx",
  "components/HeroSlider.tsx",
  "app/account/wishlist/page.tsx",
  "components/RelatedProducts.tsx",
];

describe("SmartImage static checks", () => {
  it("in-scope files have no raw <img elements", () => {
    for (const rel of IN_SCOPE) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      assert.equal(/<img\b/.test(src), false, `${rel} still has <img`);
    }
  });

  it("every SmartImage usage has alt and sizes or width/height", () => {
    for (const rel of IN_SCOPE) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      // crude JSX scan for <SmartImage ... />
      const re = /<SmartImage\b([\s\S]*?)\/>/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(src))) {
        count += 1;
        const props = m[1];
        assert.match(props, /\balt=/, `${rel} SmartImage missing alt`);
        const hasSizes = /\bsizes=/.test(props);
        const hasWH = /\bwidth=/.test(props) && /\bheight=/.test(props);
        const hasFill = /\bfill\b/.test(props);
        assert.equal(
          hasSizes || hasWH || (hasFill && hasSizes),
          true,
          `${rel} SmartImage needs sizes or width+height (fill requires sizes)`
        );
        if (hasFill) {
          assert.equal(hasSizes, true, `${rel} fill SmartImage missing sizes`);
        }
      }
      assert.ok(count >= 1, `${rel} expected at least one SmartImage`);
    }
  });

  it("product JSON-LD still uses raw product.image", () => {
    const src = fs.readFileSync(
      path.join(root, "app/products/[slug]/page.tsx"),
      "utf8"
    );
    assert.match(src, /image:\s*product\.image/);
    assert.equal(/cloudinaryLoader|SmartImage|f_auto/.test(src), false);
  });

  it("SmartImage and imageLoader modules exist", () => {
    assert.equal(fs.existsSync(path.join(root, "components/SmartImage.tsx")), true);
    assert.equal(fs.existsSync(path.join(root, "lib/imageLoader.ts")), true);
  });
});
