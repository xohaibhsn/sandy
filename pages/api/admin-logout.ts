import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import {
  destroyAdminSession,
  getAdminSession,
  requireSameOriginAdminRequest,
  revokeAllCallerSessions,
} from "../../lib/adminAuth";
import { recordAudit } from "../../lib/auditLog";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireSameOriginAdminRequest(req, res)) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const scopeAll = String((body as { scope?: unknown }).scope || "") === "all";

  // Read the session BEFORE destroying it so the audit row can name the actor.
  const { session, error } = await getAdminSession(req);

  if (scopeAll) {
    if (error) {
      return res.status(503).json({ error: "Service unavailable" });
    }
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const sessionsRevoked = await revokeAllCallerSessions(req, res, session);
    await recordAudit(pool, {
      actor: session,
      action: "logout",
      entityType: "admin_session",
      entityId: session.staffId,
      summary: `Admin logout-all: ${session.name}`,
      detail: { scope: "all", sessionsRevoked, role: session.role },
      req,
    });
    return res.status(200).json({ success: true, sessionsRevoked });
  }

  await destroyAdminSession(req, res);
  if (session) {
    await recordAudit(pool, {
      actor: session,
      action: "logout",
      entityType: "admin_session",
      entityId: session.staffId,
      summary: `Admin logout: ${session.name}`,
      detail: { role: session.role },
      req,
    });
  }
  return res.status(200).json({ success: true });
}
