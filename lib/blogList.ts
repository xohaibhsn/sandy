/** Same public list rule as pages/api/blog.ts (non-admin GET). */
export const PUBLIC_BLOG_LIST_WHERE =
  'WHERE active = 1 AND (status = "published" OR status IS NULL) ORDER BY created_at DESC';

export type BlogPostRow = {
  id: number;
  title: string;
  slug: string | null;
  excerpt: string | null;
  content: string | null;
  category: string | null;
  badge: string | null;
  badgeText?: string | null;
  emoji: string | null;
  featured_image: string | null;
  featured: number | boolean | null;
  created_at: string | Date | null;
  status: string | null;
  active: number | boolean | null;
};

export type BlogCard = {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  emoji: string;
  badge: string;
  badgeText: string;
  category: string;
  featured_image: string;
  featured: boolean;
  date: string;
  readTime: string;
};

function wordCount(content: string | null | undefined): number {
  const text = String(content || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function computeReadTime(content: string | null | undefined): string {
  const words = wordCount(content);
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

export function formatBlogDate(createdAt: string | Date | null | undefined): string {
  if (!createdAt) return "";
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Karachi",
  });
}

export function toBlogCard(row: BlogPostRow): BlogCard | null {
  if (!row || typeof row.slug !== "string" || row.slug.trim().length === 0) {
    return null;
  }
  return {
    id: Number(row.id),
    title: String(row.title || ""),
    slug: String(row.slug).trim(),
    excerpt: String(row.excerpt || ""),
    emoji: String(row.emoji || "📝"),
    badge: String(row.badge || "guide"),
    badgeText: String(row.badgeText || "Guide"),
    category: String(row.category || "Guides"),
    featured_image: String(row.featured_image || ""),
    featured: !!row.featured,
    date: formatBlogDate(row.created_at),
    readTime: computeReadTime(row.content),
  };
}

/** "All" + distinct categories in first-seen order (cards already newest-first). */
export function blogCategories(cards: BlogCard[]): string[] {
  const seen = new Set<string>();
  const cats: string[] = ["All"];
  for (const c of cards) {
    const cat = String(c.category || "").trim();
    if (!cat || seen.has(cat)) continue;
    seen.add(cat);
    cats.push(cat);
  }
  return cats;
}

/**
 * Public blog list: same WHERE/ORDER as API public list. Errors → [].
 * DB driver is loaded only inside this server function (client-safe module graph).
 */
export async function listPublicBlogPosts(): Promise<BlogPostRow[]> {
  try {
    const pool = (await import("@/lib/db")).default;
    const [rows] = await pool.query(
      `SELECT id, title, slug, excerpt, content, category, badge, badgeText,
              emoji, featured_image, featured, created_at, status, active
       FROM blog_posts
       ${PUBLIC_BLOG_LIST_WHERE}
       LIMIT 200`
    );
    return Array.isArray(rows) ? (rows as BlogPostRow[]) : [];
  } catch {
    return [];
  }
}
