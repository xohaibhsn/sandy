import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { requireAdmin, requireRole } from '../../lib/adminAuth';
import { hashAdminStaffPassword } from '../../lib/adminStaffPassword';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

    if (req.method === 'GET') {
      const session = await requireAdmin(req, res);
      if (!session) return;
      const [rows] = await pool.query('SELECT id,name,email,role,active,created_at FROM admin_staff ORDER BY created_at DESC');
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    // POST/PUT/DELETE require super_admin
    const session = await requireRole(req, res, ['super_admin']);
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
      return res.status(200).json({ success: true, id: insertId });
    }

    if (req.method === 'PUT') {
      const { id, name, email, role, password, active } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required' });
      const validRoles = ['super_admin','manager','writer'];
      const finalRole = validRoles.includes(role) ? role : 'writer';
      if (password) {
        const hash = await hashAdminStaffPassword(String(password));
        await pool.query('UPDATE admin_staff SET name=?,email=?,role=?,password_hash=?,active=? WHERE id=?',
          [name, email, finalRole, hash, active??1, id]);
      } else {
        await pool.query('UPDATE admin_staff SET name=?,email=?,role=?,active=? WHERE id=?',
          [name, email, finalRole, active??1, id]);
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      await pool.query('DELETE FROM admin_staff WHERE id=?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Server error';
    return res.status(500).json({ error: message });
  }
}
