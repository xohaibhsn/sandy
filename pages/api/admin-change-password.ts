import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import {
  getAdminSession,
  requireSameOriginAdminRequest,
  revokeStaffSessions,
} from "../../lib/adminAuth";
import {
  MASTER_PASSWORD_HOSTING_MESSAGE,
  validateAdminPasswordChangeInput,
} from "../../lib/adminChangePassword";
import {
  hashAdminStaffPassword,
  verifyAdminStaffPassword,
} from "../../lib/adminStaffPassword";
import {
  ADMIN_LOGIN_LOCK_BODY,
  checkAdminLoginGuard,
  clearAdminLoginGuard,
  recordAdminLoginFailure,
} from "../../lib/adminLoginGuard";
import { getClientIp } from "../../lib/rateLimit";
import { recordAudit } from "../../lib/auditLog";

type StaffPwRow = {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  role: string;
};

/**
 * Self-service staff password change (ADMIN-LOGIN-02).
 * Session lifecycle route: same-origin + valid staff session; not permission-gated.
 * Master sessions are refused (password lives in hosting settings).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireSameOriginAdminRequest(req, res)) return;

  const { session, error } = await getAdminSession(req);
  if (error) {
    return res.status(503).json({ error: "Service unavailable" });
  }
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (session.isMaster || session.staffId == null) {
    return res.status(403).json({ error: MASTER_PASSWORD_HOSTING_MESSAGE });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const validated = validateAdminPasswordChangeInput(body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  });
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const staffId = Number(session.staffId);
  let staff: StaffPwRow | null = null;
  try {
    const [rows] = await pool.query(
      "SELECT id,email,password_hash,name,role FROM admin_staff WHERE id=? AND active=1 LIMIT 1",
      [staffId]
    );
    staff = (Array.isArray(rows) ? rows[0] : null) as StaffPwRow | null;
  } catch {
    return res.status(503).json({ error: "Service unavailable" });
  }
  if (!staff) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const clientIp = getClientIp(req);
  const email = String(staff.email || "");
  const guard = checkAdminLoginGuard({ username: email, clientIp });
  if (guard.locked) {
    return res.status(429).json({ ...ADMIN_LOGIN_LOCK_BODY });
  }

  const check = await verifyAdminStaffPassword(
    validated.currentPassword,
    String(staff.password_hash || "")
  );
  if (!check.valid) {
    recordAdminLoginFailure({ username: email, clientIp });
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  try {
    const newHash = await hashAdminStaffPassword(validated.newPassword);
    await pool.query("UPDATE admin_staff SET password_hash=? WHERE id=?", [newHash, staffId]);
    const sessionsRevoked = await revokeStaffSessions(staffId, session.sessionId);
    clearAdminLoginGuard({ username: email, clientIp });
    await recordAudit(pool, {
      actor: session,
      action: "update",
      entityType: "admin_staff",
      entityId: staffId,
      summary: `Self password change: ${session.name}`,
      detail: { selfPasswordChange: true, sessionsRevoked },
      req,
    });
    return res.status(200).json({ success: true, sessionsRevoked });
  } catch {
    return res.status(503).json({ error: "Service unavailable" });
  }
}
