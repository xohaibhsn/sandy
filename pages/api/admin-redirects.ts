import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "../../lib/adminPermissions";
import {
  RedirectConflictError,
  RedirectNotFoundError,
  RedirectValidationError,
  RedirectsStorageMissingError,
  assertRedirectsStorage,
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
  if (
    err instanceof RedirectsStorageMissingError ||
    (typeof err === "object" && err !== null && (err as { code?: string }).code === "ER_NO_SUCH_TABLE")
  ) {
    res.status(503).json({ error: "Redirects storage not configured" });
    return;
  }
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
  const session = await requirePermission(req, res, "redirects:manage");
  if (!session) return;

  try {
    // Fail closed: the redirects table is created by migrations/0003 only. Missing => 503 for every
    // supported method (before any validation or write is attempted).
    if (
      req.method === "GET" ||
      req.method === "POST" ||
      req.method === "PUT" ||
      req.method === "DELETE"
    ) {
      await assertRedirectsStorage();
    }

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
