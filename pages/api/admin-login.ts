import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { RL_AUTH, getClientIp } from '../../lib/rateLimit';
import pool from '../../lib/db';
import {
  createAdminSession,
  requireSameOriginAdminRequest,
  setSessionCookie,
  type AdminRole,
} from '../../lib/adminAuth';
import { verifyAdminStaffPassword } from '../../lib/adminStaffPassword';
import { auditThrottle, hashAuditIp, maskEmail, recordAudit } from '../../lib/auditLog';

type StaffAuthRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  password_hash: string;
};

/** Same 15-minute window as RL_AUTH; named locally — do not import rateLimit internals. */
const AUDIT_LOGIN_RL_WINDOW_MS = 15 * 60 * 1000;

/** Login audit: never log passwords; username is masked unless it is the master "admin". */
function maskLoginName(username: unknown): string {
  const s = String(username ?? '').trim().slice(0, 120);
  if (!s) return '';
  if (s === 'admin') return s;
  if (s.includes('@')) return maskEmail(s);
  return `${s[0]}•••`;
}

async function auditLoginFailed(req: NextApiRequest, username: unknown, reason: string) {
  const name = maskLoginName(username);
  await recordAudit(pool, {
    actor: { actorType: 'anonymous', name: name || null },
    action: 'login_failed',
    entityType: 'admin_session',
    entityId: null,
    summary: `Admin login failed (${reason})`,
    detail: { reason, username: name || null },
    req,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSameOriginAdminRequest(req, res)) return;

  const clientIp = getClientIp(req);
  const { allowed } = RL_AUTH(clientIp);
  if (!allowed) {
    const username = (req.body || {}).username;
    const name = maskLoginName(username);
    const ipHash = hashAuditIp(clientIp);
    const { record, suppressed } = auditThrottle(
      `login_rl:${ipHash}`,
      AUDIT_LOGIN_RL_WINDOW_MS
    );
    if (record) {
      const detail: Record<string, unknown> = { reason: 'rate_limited', username: name || null };
      if (suppressed > 0) detail.suppressed_since_last = suppressed;
      await recordAudit(pool, {
        actor: { actorType: 'anonymous', name: name || null },
        action: 'login_failed',
        entityType: 'admin_session',
        entityId: null,
        summary: 'Admin login failed (rate_limited)',
        detail,
        req,
        ipHash,
      });
    }
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    await auditLoginFailed(req, username, 'missing_credentials');
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  // ── Check admin_staff table first (multi-user RBAC) ───────────────────────
  try {
    const [rows] = await pool.query(
      'SELECT id,name,email,role,password_hash FROM admin_staff WHERE email=? AND active=1 LIMIT 1',
      [username]
    );
    const staff = (Array.isArray(rows) ? rows[0] : null) as StaffAuthRow | null;
    if (staff) {
      const check = await verifyAdminStaffPassword(String(password), String(staff.password_hash || ''));
      if (check.valid) {
        if (check.upgradedHash) {
          try {
            const [upgradeResult] = await pool.query(
              'UPDATE admin_staff SET password_hash=? WHERE id=? AND password_hash=?',
              [check.upgradedHash, staff.id, staff.password_hash]
            );
            const affected = Number((upgradeResult as { affectedRows?: number } | undefined)?.affectedRows || 0);
            if (affected !== 1) {
              await auditLoginFailed(req, username, 'hash_upgrade_conflict');
              return res.status(401).json({ success: false });
            }
          } catch {
            await auditLoginFailed(req, username, 'service_unavailable');
            return res.status(503).json({ success: false, error: 'Service unavailable' });
          }
        }

        const role = (staff.role || 'writer') as AdminRole;
        try {
          const rawToken = await createAdminSession({
            staffId: Number(staff.id),
            isMaster: false,
            role,
            name: String(staff.name || 'Admin'),
          });
          setSessionCookie(res, rawToken);
          await recordAudit(pool, {
            actor: {
              actorType: 'staff',
              staffId: Number(staff.id),
              name: String(staff.name || 'Admin'),
              role,
            },
            action: 'login_success',
            entityType: 'admin_session',
            entityId: Number(staff.id),
            summary: `Staff login: ${String(staff.name || 'Admin')}`,
            detail: { username: maskLoginName(username), role },
            req,
          });
          return res.status(200).json({ success: true, role, name: staff.name, staffUser: true });
        } catch {
          await auditLoginFailed(req, username, 'service_unavailable');
          return res.status(503).json({ success: false, error: 'Service unavailable' });
        }
      }
      // Wrong staff password: do not create a staff session. Fall through so
      // existing master-admin username "admin" behavior remains unchanged.
    }
  } catch { /* admin_staff unavailable (migration 0003 not applied) — fall through to master admin check */ }

  // ── Master admin login (username must be 'admin') ─────────────────────────
  if (username !== 'admin') {
    await auditLoginFailed(req, username, 'wrong_password');
    return res.status(401).json({ success: false });
  }

  const hashEnv   = process.env.ADMIN_PASSWORD_HASH;
  const sha256Env = process.env.ADMIN_PASSWORD_SHA256;
  const plainEnv  = process.env.ADMIN_PASSWORD;

  const finishMaster = async () => {
    try {
      const rawToken = await createAdminSession({
        staffId: null,
        isMaster: true,
        role: 'super_admin',
        name: 'Admin',
      });
      setSessionCookie(res, rawToken);
      await recordAudit(pool, {
        actor: { actorType: 'master', name: 'Admin', role: 'super_admin' },
        action: 'login_success',
        entityType: 'admin_session',
        entityId: null,
        summary: 'Master admin login',
        detail: { username: 'admin', role: 'super_admin' },
        req,
      });
      return res.status(200).json({ success: true, role: 'super_admin', name: 'Admin' });
    } catch {
      await auditLoginFailed(req, 'admin', 'service_unavailable');
      return res.status(503).json({ success: false, error: 'Service unavailable' });
    }
  };

  if (sha256Env) {
    const inputHash = crypto.createHash('sha256').update(String(password)).digest('hex');
    if (inputHash === sha256Env) {
      return finishMaster();
    }
  }

  if (hashEnv && hashEnv.startsWith('$2')) {
    try {
      const bcrypt = require('bcryptjs');
      const match = await bcrypt.compare(String(password), hashEnv);
      if (match) {
        return finishMaster();
      }
    } catch {}
  }

  if (plainEnv && String(password) === plainEnv) {
    return finishMaster();
  }

  if (!hashEnv && !sha256Env && !plainEnv) {
    await auditLoginFailed(req, username, 'server_not_configured');
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  await auditLoginFailed(req, username, 'wrong_password');
  return res.status(401).json({ success: false });
}
