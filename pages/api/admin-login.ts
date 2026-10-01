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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSameOriginAdminRequest(req, res)) return;

  const { allowed } = RL_AUTH(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });

  // ── Check admin_staff table first (multi-user RBAC) ───────────────────────
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_staff (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('super_admin','manager','writer') DEFAULT 'writer',
        active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const inputHash = crypto.createHash('sha256').update(String(password)).digest('hex');
    const [rows]: any = await pool.query(
      'SELECT id,name,email,role FROM admin_staff WHERE email=? AND password_hash=? AND active=1',
      [username, inputHash]
    );
    if (rows.length) {
      const staff = rows[0];
      const role = (staff.role || 'writer') as AdminRole;
      try {
        const rawToken = await createAdminSession({
          staffId: Number(staff.id),
          isMaster: false,
          role,
          name: String(staff.name || 'Admin'),
        });
        setSessionCookie(res, rawToken);
        return res.status(200).json({ success: true, role, name: staff.name, staffUser: true });
      } catch {
        return res.status(503).json({ success: false, error: 'Service unavailable' });
      }
    }
  } catch { /* DB not ready yet — fall through to master admin check */ }

  // ── Master admin login (username must be 'admin') ─────────────────────────
  if (username !== 'admin') {
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
      return res.status(200).json({ success: true, role: 'super_admin', name: 'Admin' });
    } catch {
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
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  return res.status(401).json({ success: false });
}
