import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../../lib/db";
import { requireAccountCustomer } from "../../../lib/accountApi";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";

const MAX_WISHLIST = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR";
}

function isMysqlDupEntry(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1062 || e.code === "ER_DUP_ENTRY";
}

function parseProductId(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function requestProductId(req: NextApiRequest, body: Record<string, unknown>): number | null {
  const fromBody = parseProductId(body.productId);
  if (fromBody !== null) return fromBody;
  const q = req.query.productId;
  return parseProductId(Array.isArray(q) ? q[0] : q);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");

  const method = String(req.method || "").toUpperCase();
  const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};

  try {
    if (method === "GET") {
      // Only products that still exist and are active (NULL active = legacy active row).
      const sql = (columns: string) =>
        `SELECT ${columns}
         FROM customer_wishlist w
         INNER JOIN products p ON p.id = w.product_id
         WHERE w.customer_id = ? AND (p.active = 1 OR p.active IS NULL)
         ORDER BY w.id DESC
         LIMIT ${MAX_WISHLIST}`;
      let rows: RowDataPacket[];
      try {
        [rows] = await pool.query<RowDataPacket[]>(
          sql("p.id AS product_id, p.name, p.price, p.slug, p.image, w.created_at"),
          [me.id]
        );
      } catch (err) {
        if (!isMissingColumnError(err)) throw err;
        // Older schema without slug/image: still return the essentials.
        [rows] = await pool.query<RowDataPacket[]>(
          sql("p.id AS product_id, p.name, p.price, w.created_at"),
          [me.id]
        );
      }
      return res.status(200).json({
        items: (Array.isArray(rows) ? rows : []).map((r) => ({
          product_id: Number(r.product_id),
          name: r.name != null ? String(r.name) : "",
          price: r.price,
          slug: r.slug != null ? String(r.slug) : null,
          image: r.image != null ? String(r.image) : null,
          created_at: r.created_at,
        })),
      });
    }

    if (method === "POST") {
      const productId = parseProductId(body.productId);
      if (productId === null) {
        return res.status(400).json({ error: "Invalid request" });
      }

      const [productRows] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM products WHERE id = ? AND (active = 1 OR active IS NULL) LIMIT 1`,
        [productId]
      );
      if (!Array.isArray(productRows) || productRows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }

      const [countRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM customer_wishlist WHERE customer_id = ?`,
        [me.id]
      );
      if ((Number(countRows?.[0]?.n) || 0) >= MAX_WISHLIST) {
        return res.status(400).json({ error: "Invalid request" });
      }

      try {
        await pool.query<ResultSetHeader>(
          `INSERT INTO customer_wishlist (customer_id, product_id) VALUES (?, ?)`,
          [me.id, productId]
        );
      } catch (err) {
        // Already on the list: idempotent success.
        if (isMysqlDupEntry(err)) {
          return res.status(200).json({ ok: true });
        }
        throw err;
      }
      return res.status(201).json({ ok: true });
    }

    if (method === "DELETE") {
      const productId = requestProductId(req, body);
      if (productId === null) {
        return res.status(400).json({ error: "Invalid request" });
      }
      await pool.query(`DELETE FROM customer_wishlist WHERE customer_id = ? AND product_id = ?`, [
        me.id,
        productId,
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/account/wishlist] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
  }
}
