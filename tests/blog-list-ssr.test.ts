import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const {
  toBlogCard,
  blogCategories,
  computeReadTime,
  formatBlogDate,
  PUBLIC_BLOG_LIST_WHERE,
} = await import("../lib/blogList.ts");
type BlogPostRow = import("../lib/blogList.ts").BlogPostRow;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "8b41a2e52ecbb28c6c88c7e4b1cc88309ac5bac2";

function row(partial: Partial<BlogPostRow> & Pick<BlogPostRow, "id" | "title">): BlogPostRow {
  return {
    slug: "post",
    excerpt: "ex",
    content: "word ",
    category: "Guides",
    badge: "guide",
    badgeText: "Guide",
    emoji: "📝",
    featured_image: "",
    featured: 0,
    created_at: "2026-11-26T10:00:00Z",
    status: "published",
    active: 1,
    ...partial,
  };
}

describe("toBlogCard", () => {
  it("returns null when slug missing", () => {
    assert.equal(toBlogCard(row({ id: 1, title: "T", slug: null })), null);
    assert.equal(toBlogCard(row({ id: 1, title: "T", slug: "  " })), null);
    assert.equal(toBlogCard(row({ id: 1, title: "T", slug: "" })), null);
  });

  it("computes read time 1 / 2 / 5 min", () => {
    assert.equal(computeReadTime(""), "1 min read");
    assert.equal(computeReadTime("one two"), "1 min read");
    const words200 = Array.from({ length: 200 }, () => "w").join(" ");
    assert.equal(computeReadTime(words200), "1 min read");
    const words201 = Array.from({ length: 201 }, () => "w").join(" ");
    assert.equal(computeReadTime(words201), "2 min read");
    const words1000 = Array.from({ length: 1000 }, () => "w").join(" ");
    assert.equal(computeReadTime(words1000), "5 min read");
    const card = toBlogCard(row({ id: 2, title: "Long", content: words1000, slug: "long" }));
    assert.ok(card);
    assert.equal(card!.readTime, "5 min read");
  });

  it("formats date in Asia/Karachi as D Month YYYY", () => {
    // 2026-11-25 22:00 UTC = 2026-11-26 03:00 PKT
    const d = formatBlogDate("2026-11-25T22:00:00.000Z");
    assert.equal(d, "26 November 2026");
    const card = toBlogCard(
      row({ id: 3, title: "D", slug: "d", created_at: "2026-11-25T22:00:00.000Z" })
    );
    assert.ok(card);
    assert.equal(card!.date, "26 November 2026");
  });

  it("applies defaults for emoji/badge/category", () => {
    const card = toBlogCard(
      row({
        id: 4,
        title: "Defaults",
        slug: "defaults",
        emoji: null,
        badge: null,
        badgeText: null,
        category: null,
      })
    );
    assert.ok(card);
    assert.equal(card!.emoji, "📝");
    assert.equal(card!.badge, "guide");
    assert.equal(card!.badgeText, "Guide");
    assert.equal(card!.category, "Guides");
  });
});

describe("blogCategories", () => {
  it("dedupes, keeps All first, stable order", () => {
    const cards = [
      toBlogCard(row({ id: 1, title: "A", slug: "a", category: "Tips" }))!,
      toBlogCard(row({ id: 2, title: "B", slug: "b", category: "Guides" }))!,
      toBlogCard(row({ id: 3, title: "C", slug: "c", category: "Tips" }))!,
      toBlogCard(row({ id: 4, title: "D", slug: "d", category: "News" }))!,
    ];
    assert.deepEqual(blogCategories(cards), ["All", "Tips", "Guides", "News"]);
  });

  it("single category yields All + that category", () => {
    const cards = [
      toBlogCard(row({ id: 1, title: "A", slug: "a", category: "Guides" }))!,
      toBlogCard(row({ id: 2, title: "B", slug: "b", category: "Guides" }))!,
    ];
    assert.deepEqual(blogCategories(cards), ["All", "Guides"]);
  });
});

describe("listPublicBlogPosts WHERE rule", () => {
  it("matches pages/api/blog.ts public list rule", () => {
    const api = fs.readFileSync(path.join(root, "pages/api/blog.ts"), "utf8");
    const m = api.match(
      /'SELECT \* FROM blog_posts WHERE active = 1 AND \(status = "published" OR status IS NULL\) ORDER BY created_at DESC'/
    );
    assert.ok(m, "API public list query missing");
    assert.equal(
      PUBLIC_BLOG_LIST_WHERE,
      'WHERE active = 1 AND (status = "published" OR status IS NULL) ORDER BY created_at DESC'
    );
    assert.ok(m[0].includes(PUBLIC_BLOG_LIST_WHERE.replace(/^WHERE /, "WHERE ")));
  });
});

describe("blog SSR static checks", () => {
  it("app/blog/page.tsx has no use client and no fetch(/api/blog)", () => {
    const src = fs.readFileSync(path.join(root, "app/blog/page.tsx"), "utf8");
    assert.equal(/["']use client["']/.test(src), false);
    assert.equal(/fetch\s*\(\s*["']\/api\/blog["']/.test(src), false);
  });

  it("BlogListClient has no router.push and no setSubscribed", () => {
    const src = fs.readFileSync(
      path.join(root, "components/blog/BlogListClient.tsx"),
      "utf8"
    );
    assert.equal(/router\.push/.test(src), false);
    assert.equal(/setSubscribed/.test(src), false);
  });

  it("layout.tsx unchanged vs 8b41a2e", () => {
    const out = execFileSync(
      "git",
      ["diff", BASE, "--", "app/blog/layout.tsx"],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(out, "");
  });
});
