import type { NextApiRequest, NextApiResponse } from "next";
import { requireRole } from "../../lib/adminAuth";
import {
  RedirectConflictError,
  RedirectNotFoundError,
  RedirectValidationError,
  createRedirect,
  deleteRedirect,
  listRedirects,
  updateRedirect,
} from "../../lib/redirects";

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function sendError(res: NextApiResponse, err: unknown): void {
  if (err instanceof RedirectValidationError) {
    res.status(400).json({ error: "Validation error" });
    return;
  }
  if (err instanceof RedirectConflictError) {
    res.status(409).json({ error: "Conflict" });
    return;
  }
  if (err instanceof RedirectNotFoundError) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(503).json({ error: "Service unavailable" });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res, ["super_admin", "manager"]);
  if (!session) return;

  try {
    if (req.method === "GET") {
      const rows = await listRedirects();
      return res.status(200).json(rows);
    }

    if (req.method === "POST") {
      const created = await createRedirect(req.body || {});
      return res.status(200).json({ success: true, redirect: created });
    }

    if (req.method === "PUT") {
      const updated = await updateRedirect(req.body || {});
      return res.status(200).json({ success: true, redirect: updated });
    }

    if (req.method === "DELETE") {
      const id = parsePositiveId(req.query.id);
      if (id == null) {
        return res.status(400).json({ error: "Validation error" });
      }
      await deleteRedirect(id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    sendError(res, err);
  }
}
