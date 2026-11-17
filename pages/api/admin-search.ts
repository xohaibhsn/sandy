import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { getClientIp, RL_SEARCH } from "../../lib/rateLimit";
import {
  ADMIN_SEARCH_MAX,
  ADMIN_SEARCH_MIN,
  parseAdminSearchQuery,
  runAdminSearch,
} from "../../lib/adminSearchQuery";

/**
 * ADMIN-SEARCH-01 — global admin search (GET only, read-only).
 *
 *   GET /api/admin-search?q=<2..80 chars>
 *
 * Auth: any authenticated admin (401 without a session cookie). Role scope is applied server side:
 *   super_admin | manager -> orders, customers, products, blog, faqs
 *   writer                -> blog, faqs only (orders/customers/products keys are omitted)
 * At most 5 hits per group. Never returns receipt_path / payment_reference / addresses.
 *
 * 200: {
 *   success: true,
 *   q: string,
 *   groups: {
 *     orders?:    { order_id, status, created_at, customer_name, customer_email }[],
 *     customers?: { customer_email, customer_name, order_count, last_order }[],
 *     products?:  { id, name, slug }[],
 *     blog:       { id, title, slug, status }[],
 *     faqs:       { id, question }[]
 *   }
 * }
 * 400 invalid q | 401 no session | 405 wrong method | 429 rate limited (Retry-After) | 500 generic.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await requirePermission(req, res, "search:query");
  if (!session) return;

  const rl = RL_SEARCH(getClientIp(req));
  if (!rl.allowed) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests" });
  }

  const rawQ = Array.isArray(req.query.q) ? undefined : req.query.q;
  const q = parseAdminSearchQuery(rawQ);
  if (!q) {
    return res
      .status(400)
      .json({ error: `Query must be ${ADMIN_SEARCH_MIN}-${ADMIN_SEARCH_MAX} characters` });
  }

  try {
    const groups = await runAdminSearch(pool, q, session.role);
    return res.status(200).json({ success: true, q, groups });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    console.error("[admin-search]", msg.slice(0, 200));
    return res.status(500).json({ error: "Search failed" });
  }
}
