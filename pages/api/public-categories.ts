import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2";
import pool from "../../lib/db";

type PublicCategoryRow = RowDataPacket & {
  id: number;
  name: string;
  slug: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [rows] = await pool.query<PublicCategoryRow[]>(
      `SELECT id, name, slug
       FROM categories
       WHERE active = 1
       ORDER BY sort_order ASC, name ASC, id ASC`
    );
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch {
    return res.status(500).json({ error: "Unable to load categories" });
  }
}
