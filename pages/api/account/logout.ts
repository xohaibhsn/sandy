import type { NextApiRequest, NextApiResponse } from "next";
import { requireAccountsEnabled } from "../../../lib/accountApi";
import {
  destroyCustomerSession,
  requireSameOriginCustomerRequest,
} from "../../../lib/customerAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireAccountsEnabled(res))) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireSameOriginCustomerRequest(req, res)) return;

  await destroyCustomerSession(req, res);
  return res.status(200).json({ ok: true });
}
