import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { requireAccountCustomer } from "../../../lib/accountApi";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { clearCustomerSessionCookie, revokeAllCustomerSessions } from "../../../lib/customerAuth";

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  if (body.confirm !== "DELETE") {
    return res.status(400).json({ error: "Invalid request" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await revokeAllCustomerSessions(me.id, connection);
    await connection.query(`DELETE FROM customer_addresses WHERE customer_id = ?`, [me.id]);
    await connection.query(`DELETE FROM customer_wishlist WHERE customer_id = ?`, [me.id]);

    // Orders are kept for store records; only the link to the account is removed.
    try {
      await connection.query(`UPDATE orders SET customer_id = NULL WHERE customer_id = ?`, [me.id]);
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
    }

    await connection.query(`DELETE FROM customers WHERE id = ?`, [me.id]);
    // customer_blacklist is intentionally untouched.
    await connection.commit();

    clearCustomerSessionCookie(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    console.error("[api/account/delete] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
  } finally {
    connection.release();
  }
}
