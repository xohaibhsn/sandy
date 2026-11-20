import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { auditFieldDiff, recordAudit } from "../../lib/auditLog";
import {
  RedirectConflictError,
  RedirectNotFoundError,
  RedirectValidationError,
  RedirectsStorageMissingError,
  type RedirectRecord,
  assertRedirectsStorage,
  createRedirect,
  deleteRedirect,
  getRedirectById,
  listRedirects,
  updateRedirect,
} from "../../lib/redirects";

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Best-effort snapshot for audit diffs; never blocks the mutation. */
async function snapshotRedirect(id: number): Promise<RedirectRecord | null> {
  try {
    return await getRedirectById(id);
  } catch {
    return null;
  }
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
      await recordAudit(pool, {
        actor: session,
        action: "create",
        entityType: "redirect",
        entityId: created.id,
        summary: `Created redirect ${created.source_path}`,
        detail: {
          source_path: created.source_path,
          destination: created.destination,
          status_code: created.status_code,
          is_active: created.is_active,
        },
        req,
      });
      return res.status(200).json({ success: true, redirect: created });
    }

    if (req.method === "PUT") {
      const beforeId = Number((req.body || {}).id);
      const before = Number.isInteger(beforeId) && beforeId > 0 ? await snapshotRedirect(beforeId) : null;
      const updated = await updateRedirect(req.body || {});
      await recordAudit(pool, {
        actor: session,
        action: "update",
        entityType: "redirect",
        entityId: updated.id,
        summary: `Updated redirect ${updated.source_path}`,
        detail: {
          changes: auditFieldDiff(
            before
              ? {
                  source_path: before.source_path,
                  destination: before.destination,
                  status_code: before.status_code,
                  is_active: !!before.is_active,
                }
              : null,
            {
              source_path: updated.source_path,
              destination: updated.destination,
              status_code: updated.status_code,
              is_active: !!updated.is_active,
            }
          ),
        },
        req,
      });
      return res.status(200).json({ success: true, redirect: updated });
    }

    if (req.method === "DELETE") {
      const id = parsePositiveId(req.query.id);
      if (id == null) {
        return res.status(400).json({ error: "Validation error" });
      }
      const before = await snapshotRedirect(id);
      await deleteRedirect(id);
      await recordAudit(pool, {
        actor: session,
        action: "delete",
        entityType: "redirect",
        entityId: id,
        summary: `Deleted redirect ${before ? before.source_path : `#${id}`}`,
        detail: before
          ? { source_path: before.source_path, destination: before.destination, status_code: before.status_code }
          : null,
        req,
      });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    sendError(res, err);
  }
}
