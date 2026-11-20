import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { requirePermission } from '../../lib/adminPermissions';
import { hashAdminStaffPassword } from '../../lib/adminStaffPassword';
import { revokeStaffSessions } from '../../lib/adminAuth';
import { auditFieldDiff, recordAudit } from '../../lib/auditLog';

type StaffRow = {
  id: number;
  name: unknown;
  email: unknown;
  role: unknown;
  active: unknown;
};

async function countActiveSuperAdmins(): Promise<number> {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS c FROM admin_staff WHERE role='super_admin' AND active=1"
  );
  const row = (Array.isArray(rows) ? rows[0] : null) as { c?: number } | null;
  return Number(row?.c || 0);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      // Finding 7: staff directory (emails, roles) is super_admin only.
      const session = await requirePermission(req, res, 'staff:view');
      if (!session) return;
      const [rows] = await pool.query('SELECT id,name,email,role,active,created_at FROM admin_staff ORDER BY created_at DESC');
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    // POST/PUT/DELETE require super_admin
    const session = await requirePermission(req, res, 'staff:write');
    if (!session) return;

    if (req.method === 'POST') {
      const { name, email, password, role } = req.body;
      if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
      const validRoles = ['super_admin','manager','writer'];
      const finalRole = validRoles.includes(role) ? role : 'writer';
      const hash = await hashAdminStaffPassword(String(password));
      const [result] = await pool.query(
        'INSERT INTO admin_staff (name,email,password_hash,role) VALUES (?,?,?,?)',
        [name, email, hash, finalRole]
      );
      const insertId = Number((result as { insertId?: number } | undefined)?.insertId || 0);
      await recordAudit(pool, {
        actor: session,
        action: 'create',
        entityType: 'admin_staff',
        entityId: insertId || null,
        summary: `Created staff user "${String(name).slice(0, 80)}" (${finalRole})`,
        detail: { name, email, role: finalRole, credentialSet: true },
        req,
      });
      return res.status(200).json({ success: true, id: insertId });
    }

    if (req.method === 'PUT') {
      const { id, name, email, role, password, active } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required' });
      const validRoles = ['super_admin','manager','writer'];
      const finalRole = validRoles.includes(role) ? role : 'writer';
      const targetId = Number(id);
      const [beforeRows] = await pool.query(
        'SELECT id,name,email,role,active FROM admin_staff WHERE id=? LIMIT 1',
        [targetId]
      );
      const before = (Array.isArray(beforeRows) ? beforeRows[0] : null) as StaffRow | null;
      if (!before) return res.status(404).json({ error: 'Staff not found' });

      const nextActive = Number(active ?? 1);
      const wasSuper = String(before.role) === 'super_admin' && Number(before.active) === 1;
      const willBeSuper = finalRole === 'super_admin' && nextActive === 1;
      const isSelf =
        !session.isMaster &&
        session.staffId != null &&
        Number(session.staffId) === targetId;

      // L6: staff caller cannot deactivate, delete or demote THEMSELVES
      if (isSelf) {
        if (nextActive === 0) {
          return res.status(409).json({ error: 'Cannot deactivate your own account' });
        }
        if (String(before.role) === 'super_admin' && finalRole !== 'super_admin') {
          return res.status(409).json({ error: 'Cannot demote your own account' });
        }
      }

      // L6: never reduce ACTIVE super_admin staff from >=1 to 0
      if (wasSuper && !willBeSuper) {
        const activeSa = await countActiveSuperAdmins();
        if (activeSa <= 1) {
          return res.status(409).json({
            error: 'Cannot remove the last active super_admin',
          });
        }
      }

      if (password) {
        const hash = await hashAdminStaffPassword(String(password));
        await pool.query('UPDATE admin_staff SET name=?,email=?,role=?,password_hash=?,active=? WHERE id=?',
          [name, email, finalRole, hash, nextActive, targetId]);
      } else {
        await pool.query('UPDATE admin_staff SET name=?,email=?,role=?,active=? WHERE id=?',
          [name, email, finalRole, nextActive, targetId]);
      }

      let sessionsRevoked = 0;
      // L4: password change → revoke other sessions (keep caller's if self)
      if (password) {
        const exceptId =
          isSelf && session.sessionId != null ? session.sessionId : null;
        sessionsRevoked = await revokeStaffSessions(targetId, exceptId);
      }
      // L4: deactivate → revoke all that staff member's sessions
      if (nextActive === 0) {
        sessionsRevoked = await revokeStaffSessions(targetId);
      }

      if (before) {
        const changes = auditFieldDiff(
          { name: before.name, email: before.email, role: before.role, active: Number(before.active) },
          { name, email, role: finalRole, active: nextActive }
        );
        await recordAudit(pool, {
          actor: session,
          action: 'update',
          entityType: 'admin_staff',
          entityId: String(id),
          summary: `Updated staff user #${String(id).slice(0, 20)}`,
          detail: { changes, credentialChanged: !!password, sessionsRevoked },
          req,
        });
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      const targetId = Number(id);
      const [beforeRows] = await pool.query(
        'SELECT id,name,email,role,active FROM admin_staff WHERE id=? LIMIT 1',
        [targetId]
      );
      const before = (Array.isArray(beforeRows) ? beforeRows[0] : null) as StaffRow | null;
      if (!before) return res.status(404).json({ error: 'Staff not found' });

      const isSelf =
        !session.isMaster &&
        session.staffId != null &&
        Number(session.staffId) === targetId;
      if (isSelf) {
        return res.status(409).json({ error: 'Cannot delete your own account' });
      }

      if (String(before.role) === 'super_admin' && Number(before.active) === 1) {
        const activeSa = await countActiveSuperAdmins();
        if (activeSa <= 1) {
          return res.status(409).json({
            error: 'Cannot remove the last active super_admin',
          });
        }
      }

      // L4: delete staff → revoke all sessions first
      const sessionsRevoked = await revokeStaffSessions(targetId);
      await pool.query('DELETE FROM admin_staff WHERE id=?', [targetId]);
      if (before) {
        await recordAudit(pool, {
          actor: session,
          action: 'delete',
          entityType: 'admin_staff',
          entityId: String(id),
          summary: `Deleted staff user "${String(before.name ?? '').slice(0, 80)}"`,
          detail: {
            name: before.name,
            email: before.email,
            role: before.role,
            sessionsRevoked,
          },
          req,
        });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error('[api/admin-staff] request failed', typeof code === 'string' ? code : 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
