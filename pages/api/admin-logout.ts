import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import {
  destroyAdminSession,
  getAdminSession,
  requireSameOriginAdminRequest,
} from "../../lib/adminAuth";
import { recordAudit } from "../../lib/auditLog";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireSameOriginAdminRequest(req, res)) return;
  // Read the session BEFORE destroying it so the audit row can name the actor.
  const { session } = await getAdminSession(req);
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
