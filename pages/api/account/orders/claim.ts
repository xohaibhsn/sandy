import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader } from "mysql2/promise";
import pool from "../../../../lib/db";
import { requireAccountCustomer } from "../../../../lib/accountApi";

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

  try {
    // The phone was proven by OTP at login; only unlinked orders with that phone are claimed.
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE orders SET customer_id = ?
       WHERE customer_id IS NULL AND customer_phone_norm = ?`,
      [me.id, me.phone_norm]
    );
    return res.status(200).json({ linked: Number(result?.affectedRows) || 0 });
  } catch (err) {
    if (isMissingColumnError(err)) {
      console.error("[api/account/orders/claim] failed", "MISSING_COLUMN");
      return res.status(503).json({ error: "Service unavailable" });
    }
    console.error("[api/account/orders/claim] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
