import type { NextApiRequest, NextApiResponse } from "next";
import { requireAccountCustomer } from "../../../lib/accountApi";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    customer: {
      id: me.id,
      phone_norm: me.phone_norm,
      name: me.name,
      email: me.email,
    },
  });
}
