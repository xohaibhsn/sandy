import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminSession } from "../../lib/adminAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { session, error } = await getAdminSession(req);
  if (error) {
    return res.status(503).json({ authenticated: false, error: "Service unavailable" });
  }
  if (!session) {
    return res.status(200).json({ authenticated: false });
  }
  return res.status(200).json({
    authenticated: true,
    role: session.role,
    name: session.name,
  });
}
