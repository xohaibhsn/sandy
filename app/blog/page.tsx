import BlogListClient from "@/components/blog/BlogListClient";
import { getContactConfig } from "@/lib/contact-config";
import { blogCategories, listPublicBlogPosts, toBlogCard } from "@/lib/blogList";
import type { BlogCard } from "@/lib/blogList";
import { getSiteContentMap } from "@/lib/siteContent";

export default async function BlogPage() {
  const rows = await listPublicBlogPosts();
  const cards: BlogCard[] = [];
  for (const row of rows) {
    const card = toBlogCard(row);
    if (card) cards.push(card);
  }
  const categories = blogCategories(cards);
  const contact = await getContactConfig();
  const siteContent = await getSiteContentMap();
  const emptyText =
    (siteContent.blog_empty && String(siteContent.blog_empty).trim()) ||
    "New articles are coming soon.";
  return (
    <BlogListClient
      cards={cards}
      categories={categories}
      whatsappUrl={contact.whatsappUrl}
      emptyText={emptyText}
    />
  );
}
