/**
 * ADMIN-SEARCH-01 — query layer for the global admin search (no request-time DDL).
 *
 * Role scope is enforced HERE (server side), not in the UI:
 *   super_admin | manager -> orders, customers, products, blog, faqs
 *   writer (and any unknown role) -> blog, faqs only (other group keys are omitted)
 *
 * Never selects receipt_path / payment_reference / delivery address / notes.
 */
import type { RowDataPacket } from "mysql2";
import { escapeLikeWildcards } from "./adminOrdersQuery";

export const ADMIN_SEARCH_MIN = 2;
export const ADMIN_SEARCH_MAX = 80;
export const ADMIN_SEARCH_GROUP_LIMIT = 5;

export type AdminSearchRole = "super_admin" | "manager" | "writer";

export type OrderHit = {
  order_id: string;
  status: string;
  created_at: string | null;
  customer_name: string;
  customer_email: string;
};
export type CustomerHit = {
  customer_email: string;
  customer_name: string;
  order_count: number;
  last_order: string | null;
};
export type ProductHit = { id: number; name: string; slug: string };
export type BlogHit = { id: number; title: string; slug: string; status: string };
export type FaqHit = { id: number; question: string };

export type AdminSearchGroups = {
  orders?: OrderHit[];
  customers?: CustomerHit[];
  products?: ProductHit[];
  blog?: BlogHit[];
  faqs?: FaqHit[];
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/** Trim and bound-check; returns null when the query is not acceptable. */
export function parseAdminSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim();
  if (q.length < ADMIN_SEARCH_MIN || q.length > ADMIN_SEARCH_MAX) return null;
  return q;
}

export function groupsForRole(role: string): Array<keyof AdminSearchGroups> {
  if (role === "super_admin" || role === "manager") {
    return ["orders", "customers", "products", "blog", "faqs"];
  }
  return ["blog", "faqs"];
}

function rowsOf(result: unknown): RowDataPacket[] {
  const first = Array.isArray(result) ? result[0] : null;
  return Array.isArray(first) ? (first as RowDataPacket[]) : [];
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function dateStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const ESC = "ESCAPE '\\\\'";

export async function runAdminSearch(
  db: Queryable,
  q: string,
  role: string,
  limit = ADMIN_SEARCH_GROUP_LIMIT
): Promise<AdminSearchGroups> {
  const like = `%${escapeLikeWildcards(q)}%`;
  const wanted = new Set(groupsForRole(role));
  const out: AdminSearchGroups = {};
  const jobs: Array<Promise<void>> = [];

  if (wanted.has("orders")) {
    jobs.push(
      db
        .query(
          `SELECT order_id, status, created_at, customer_name, customer_email
           FROM orders
           WHERE order_id LIKE ? ${ESC}
              OR customer_name LIKE ? ${ESC}
              OR customer_email LIKE ? ${ESC}
              OR customer_phone LIKE ? ${ESC}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
          [like, like, like, like, limit]
        )
        .then((r) => {
          out.orders = rowsOf(r).map((x) => ({
            order_id: str(x.order_id),
            status: str(x.status),
            created_at: dateStr(x.created_at),
            customer_name: str(x.customer_name),
            customer_email: str(x.customer_email),
          }));
        })
    );
  }

  if (wanted.has("customers")) {
    jobs.push(
      db
        .query(
          `SELECT customer_email,
                  MAX(customer_name) AS customer_name,
                  COUNT(*) AS order_count,
                  MAX(created_at) AS last_order
           FROM orders
           WHERE customer_email IS NOT NULL AND customer_email <> ''
             AND (customer_email LIKE ? ${ESC} OR customer_name LIKE ? ${ESC})
           GROUP BY customer_email
           ORDER BY last_order DESC, customer_email ASC
           LIMIT ?`,
          [like, like, limit]
        )
        .then((r) => {
          out.customers = rowsOf(r).map((x) => ({
            customer_email: str(x.customer_email),
            customer_name: str(x.customer_name),
            order_count: Number(x.order_count) || 0,
            last_order: dateStr(x.last_order),
          }));
        })
    );
  }

  if (wanted.has("products")) {
    jobs.push(
      db
        .query(
          `SELECT id, name, slug
           FROM products
           WHERE name LIKE ? ${ESC} OR slug LIKE ? ${ESC}
           ORDER BY id DESC
           LIMIT ?`,
          [like, like, limit]
        )
        .then((r) => {
          out.products = rowsOf(r).map((x) => ({
            id: Number(x.id),
            name: str(x.name),
            slug: str(x.slug),
          }));
        })
    );
  }

  if (wanted.has("blog")) {
    jobs.push(
      db
        .query(
          `SELECT id, title, slug, status
           FROM blog_posts
           WHERE title LIKE ? ${ESC}
           ORDER BY id DESC
           LIMIT ?`,
          [like, limit]
        )
        .then((r) => {
          out.blog = rowsOf(r).map((x) => ({
            id: Number(x.id),
            title: str(x.title),
            slug: str(x.slug),
            status: str(x.status),
          }));
        })
    );
  }

  if (wanted.has("faqs")) {
    jobs.push(
      db
        .query(
          `SELECT id, question
           FROM faqs
           WHERE question LIKE ? ${ESC}
           ORDER BY id DESC
           LIMIT ?`,
          [like, limit]
        )
        .then((r) => {
          out.faqs = rowsOf(r).map((x) => ({
            id: Number(x.id),
            question: str(x.question).slice(0, 240),
          }));
        })
    );
  }

  await Promise.all(jobs);
  return out;
}
