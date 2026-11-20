/**
 * GET /api/admin-audit-log — list + CSV export (BATCH-20).
 * Permission: audit:view (super_admin only). Append-only; no POST/PUT/DELETE.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { auditCsvEscapeCell, auditTableExists } from "../../lib/auditLog";

const LIST_MAX = 100;
const EXPORT_MAX = 10_000;

function setNoStore(res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
}

function parsePage(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 25;
  return Math.min(LIST_MAX, Math.max(1, Math.floor(n)));
}

type Filters = {
  from: string | null;
  to: string | null;
  actor: string | null;
  entityType: string | null;
  action: string | null;
  q: string | null;
};

function parseFilters(query: NextApiRequest["query"]): Filters {
  const from = typeof query.from === "string" && query.from.trim() ? query.from.trim().slice(0, 32) : null;
  const to = typeof query.to === "string" && query.to.trim() ? query.to.trim().slice(0, 32) : null;
  const actor = typeof query.actor === "string" && query.actor.trim() ? query.actor.trim().slice(0, 120) : null;
  const entityType =
    typeof query.entity_type === "string" && query.entity_type.trim()
      ? query.entity_type.trim().slice(0, 40)
      : null;
  const action =
    typeof query.action === "string" && query.action.trim() ? query.action.trim().slice(0, 40) : null;
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim().slice(0, 100) : null;
  return { from, to, actor, entityType, action, q };
}

function buildWhere(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    parts.push("created_at >= ?");
    params.push(f.from);
  }
  if (f.to) {
    parts.push("created_at <= ?");
    params.push(f.to);
  }
  if (f.actor) {
    parts.push("(actor_name LIKE ? OR CAST(actor_staff_id AS CHAR) = ? OR actor_type = ?)");
    const like = `%${f.actor.replace(/[%_]/g, "")}%`;
    params.push(like, f.actor, f.actor);
  }
  if (f.entityType) {
    parts.push("entity_type = ?");
    params.push(f.entityType);
  }
  if (f.action) {
    parts.push("action = ?");
    params.push(f.action);
  }
  if (f.q) {
    parts.push("(summary LIKE ? OR entity_id LIKE ?)");
    const like = `%${f.q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    params.push(like, like);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function rowToCsv(cols: unknown[]): string {
  return cols.map(auditCsvEscapeCell).join(",");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setNoStore(res);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await requirePermission(req, res, "audit:view");
  if (!session) return;

  try {
    const exists = await auditTableExists(pool);
    if (!exists) {
      return res.status(503).json({ error: "Service unavailable" });
    }

    const filters = parseFilters(req.query);
    const { sql: whereSql, params } = buildWhere(filters);
    const isExport = String(req.query.export || "") === "csv";

    if (isExport) {
      const [countRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM admin_audit_log ${whereSql}`,
        params
      );
      const total = Number((Array.isArray(countRows) ? countRows[0] : null)?.total || 0);
      const truncated = total > EXPORT_MAX;
      const fetchLimit = Math.min(total, EXPORT_MAX);

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, created_at, actor_type, actor_staff_id, actor_name, actor_role,
                action, entity_type, entity_id, summary, detail_json
         FROM admin_audit_log
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [...params, fetchLimit]
      );

      const lines: string[] = [];
      if (truncated) {
        lines.push(`# truncated: showing first ${EXPORT_MAX} of ${total}`);
      }
      lines.push(
        rowToCsv([
          "id",
          "created_at",
          "actor_type",
          "actor_staff_id",
          "actor_name",
          "actor_role",
          "action",
          "entity_type",
          "entity_id",
          "summary",
          "detail_json",
        ])
      );
      for (const r of Array.isArray(rows) ? rows : []) {
        lines.push(
          rowToCsv([
            r.id,
            r.created_at,
            r.actor_type,
            r.actor_staff_id,
            r.actor_name,
            r.actor_role,
            r.action,
            r.entity_type,
            r.entity_id,
            r.summary,
            r.detail_json,
          ])
        );
      }
      if (truncated) {
        lines.push(`# truncated: showing first ${EXPORT_MAX} of ${total}`);
      }

      const body = `\uFEFF${lines.join("\r\n")}\r\n`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="sandy-audit-log.csv"`
      );
      return res.status(200).send(body);
    }

    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const offset = (page - 1) * limit;

    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM admin_audit_log ${whereSql}`,
      params
    );
    const total = Number((Array.isArray(countRows) ? countRows[0] : null)?.total || 0);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, created_at, actor_type, actor_staff_id, actor_name, actor_role,
              action, entity_type, entity_id, summary, detail_json, user_agent, request_id
       FROM admin_audit_log
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      rows: Array.isArray(rows) ? rows : [],
      total,
      page,
      limit,
    });
  } catch {
    return res.status(503).json({ error: "Service unavailable" });
  }
}
