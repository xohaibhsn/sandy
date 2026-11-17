import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { normaliseEmail, normalisePhone } from "../../lib/customerIdentity";

function maskPhone(raw: string | null | undefined): string {
  const s = String(raw || "");
  if (s.length < 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function maskEmail(raw: string | null | undefined): string {
  const s = String(raw || "");
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const shown = local.slice(0, 1) || "*";
  return `${shown}***@${domain}`;
}

function actorName(session: { name?: string; email?: string; role?: string }): string {
  return String(session.name || session.email || session.role || "admin").slice(0, 255);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await requirePermission(req, res, "customers:block");
  if (!session) return;

  try {
    if (method === "GET") {
      const detailId = String(req.query.id || "").trim();
      if (detailId) {
        const id = Number(detailId);
        if (!Number.isInteger(id) || id < 1) {
          return res.status(400).json({ error: "Invalid request" });
        }
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT id, phone_norm, email_norm, reason, source_order_id, created_by, created_at,
                  active, removed_by, removed_at, removed_reason
           FROM customer_blacklist WHERE id = ? LIMIT 1`,
          [id]
        );
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) return res.status(404).json({ error: "Not found" });
        return res.status(200).json({ entry: row });
      }

      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;
      const activeOnly = String(req.query.active || "1") !== "0";

      const where: string[] = [];
      const params: unknown[] = [];
      if (activeOnly) where.push("active = 1");
      if (q) {
        where.push("(phone_norm LIKE ? OR email_norm LIKE ? OR reason LIKE ?)");
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const [countRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM customer_blacklist ${whereSql}`,
        params
      );
      const total = Number(countRows?.[0]?.c || 0);

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, phone_norm, email_norm, reason, source_order_id, created_by, created_at, active
         FROM customer_blacklist ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const entries = (rows || []).map((r) => ({
        id: r.id,
        phone_masked: r.phone_norm ? maskPhone(String(r.phone_norm)) : null,
        email_masked: r.email_norm ? maskEmail(String(r.email_norm)) : null,
        reason: r.reason,
        source_order_id: r.source_order_id,
        created_by: r.created_by,
        created_at: r.created_at,
        active: Number(r.active) === 1,
      }));

      return res.status(200).json({ entries, page, limit, total });
    }

    if (method === "POST") {
      const body = req.body ?? {};
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason || reason.length > 500) {
        return res.status(400).json({ error: "Reason required" });
      }

      let phoneNorm: string | null = null;
      let emailNorm: string | null = null;
      let sourceOrderId: string | null = null;

      if (typeof body.orderId === "string" && body.orderId.trim()) {
        sourceOrderId = body.orderId.trim().slice(0, 50);
        const [orders] = await pool.query<RowDataPacket[]>(
          `SELECT customer_phone, customer_email, customer_phone_norm, customer_email_norm
           FROM orders WHERE order_id = ? LIMIT 1`,
          [sourceOrderId]
        );
        const order = Array.isArray(orders) ? orders[0] : undefined;
        if (!order) return res.status(404).json({ error: "Order not found" });
        phoneNorm =
          (order.customer_phone_norm ? String(order.customer_phone_norm) : null) ||
          normalisePhone(order.customer_phone);
        emailNorm =
          (order.customer_email_norm ? String(order.customer_email_norm) : null) ||
          normaliseEmail(order.customer_email);
      } else {
        phoneNorm = normalisePhone(body.phone);
        emailNorm = normaliseEmail(body.email);
      }

      if (!phoneNorm && !emailNorm) {
        return res.status(400).json({ error: "Phone or email required" });
      }

      const createdBy = actorName(session);
      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO customer_blacklist
          (phone_norm, email_norm, reason, source_order_id, created_by, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [phoneNorm, emailNorm, reason, sourceOrderId, createdBy]
      );

      return res.status(200).json({
        success: true,
        id: result.insertId,
        phone_norm: phoneNorm,
        email_norm: emailNorm,
      });
    }

    if (method === "PATCH" || method === "DELETE") {
      const body = req.body ?? {};
      const id = Number(body.id ?? req.query.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid request" });
      }
      const removedReason =
        typeof body.removed_reason === "string"
          ? body.removed_reason.trim()
          : typeof body.reason === "string"
            ? body.reason.trim()
            : "";
      if (!removedReason || removedReason.length > 500) {
        return res.status(400).json({ error: "removed_reason required" });
      }

      const [result] = await pool.query<ResultSetHeader>(
        `UPDATE customer_blacklist
         SET active = 0,
             removed_by = ?,
             removed_at = NOW(),
             removed_reason = ?
         WHERE id = ? AND active = 1`,
        [actorName(session), removedReason, id]
      );

      if (!result || Number(result.affectedRows) === 0) {
        return res.status(404).json({ error: "Not found or already inactive" });
      }
      return res.status(200).json({ success: true, id, active: false });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/admin-blacklist] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
