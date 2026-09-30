import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { requireAdmin } from '../../lib/adminAuth';

async function ensureMessagesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      subject VARCHAR(255),
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    await ensureMessagesTable();

    if (req.method === 'POST') {
      const { name, email, phone, subject, message } = req.body;
      if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields' });

      await pool.query(
        'INSERT INTO contact_messages (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)',
        [name, email, phone || '', subject || '', message]
      );
      return res.status(200).json({ success: true });
    }

    const session = await requireAdmin(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const [rows] = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await pool.query('DELETE FROM contact_messages WHERE id=?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
