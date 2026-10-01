import type { NextApiRequest, NextApiResponse } from "next";
import { destroyAdminSession, requireSameOriginAdminRequest } from "../../lib/adminAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireSameOriginAdminRequest(req, res)) return;
  await destroyAdminSession(req, res);
  return res.status(200).json({ success: true });
}
