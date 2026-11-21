/**
 * Staff-only receipt proxy (Finding 64).
 * GET /api/admin-receipt/<order_id>.<ext> | /api/admin-receipt/<order_id>-advance.<ext>
 * Serves private receipt bytes to authenticated staff (orders:view). Never exposes
 * Cloudinary signed URLs, public_ids, or signatures to the client.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import type { RowDataPacket } from "mysql2/promise";
import { requirePermission } from "../../../lib/adminPermissions";
import type { AdminSession } from "../../../lib/adminAuth";
import pool from "../../../lib/db";
import { auditThrottle, recordAudit } from "../../../lib/auditLog";
import {
  assertSafeReceiptUrl,
  UrlValidationError,
} from "../../../lib/urlValidation";
import {
  cloudinaryPublicIdForRef,
  contentTypeForReceiptExt,
  isOpaqueReceiptRef,
  parseReceiptRef,
  privateReceiptsDir,
  type ReceiptRefExt,
} from "../../../lib/receiptRef";

const MAX_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const AUDIT_WINDOW_MS = 10 * 60 * 1000;

type SignUrlFn = (args: {
  publicId: string;
  resourceType: "image" | "raw";
  format: string;
}) => string;

type FetchFn = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const rateMap = new Map<string, { count: number; windowStart: number }>();

let injectedSignUrl: SignUrlFn | null = null;
let injectedFetch: FetchFn | null = null;

/** Test-only dependency injection (no network in suites). */
export function __setReceiptProxyDepsForTests(deps: {
  signUrl?: SignUrlFn | null;
  fetch?: FetchFn | null;
} | null): void {
  if (!deps) {
    injectedSignUrl = null;
    injectedFetch = null;
    return;
  }
  if (deps.signUrl !== undefined) injectedSignUrl = deps.signUrl;
  if (deps.fetch !== undefined) injectedFetch = deps.fetch;
}

export function __clearReceiptProxyRateLimitForTests(): void {
  rateMap.clear();
}

function parseFileParam(
  raw: unknown
): { orderId: string; kind: "receipt" | "advance"; ext: ReceiptRefExt } | null {
  if (typeof raw !== "string") return null;
  const file = raw.trim();
  if (!file || file.length > 96) return null;
  if (file.includes("..") || file.includes("/") || file.includes("\\")) return null;

  const advance = /^([A-Za-z0-9][A-Za-z0-9_-]{0,62})-advance\.(jpg|png|webp|pdf)$/.exec(file);
  if (advance) {
    return {
      orderId: advance[1],
      kind: "advance",
      ext: advance[2] as ReceiptRefExt,
    };
  }
  const normal = /^([A-Za-z0-9][A-Za-z0-9_-]{0,62})\.(jpg|png|webp|pdf)$/.exec(file);
  if (normal) {
    return {
      orderId: normal[1],
      kind: "receipt",
      ext: normal[2] as ReceiptRefExt,
    };
  }
  return null;
}

function allowStaffRate(sessionKey: string): boolean {
  const now = Date.now();
  const cur = rateMap.get(sessionKey);
  if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
    if (rateMap.size >= 2000) {
      const oldest = rateMap.keys().next().value;
      if (oldest !== undefined) rateMap.delete(oldest);
    }
    rateMap.set(sessionKey, { count: 1, windowStart: now });
    return true;
  }
  if (cur.count >= RATE_LIMIT) return false;
  cur.count += 1;
  return true;
}

function defaultSignUrl(args: {
  publicId: string;
  resourceType: "image" | "raw";
  format: string;
}): string {
  // Dynamic import kept sync via require for the default path (tests inject instead).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cloudinary = require("../../../lib/cloudinary").default as {
    url: (publicId: string, opts: Record<string, unknown>) => string;
  };
  return cloudinary.url(args.publicId, {
    type: "authenticated",
    sign_url: true,
    resource_type: args.resourceType,
    format: args.format,
    secure: true,
  });
}

function setReceiptHeaders(
  res: NextApiResponse,
  ext: ReceiptRefExt,
  orderId: string
): void {
  res.setHeader("Content-Type", contentTypeForReceiptExt(ext));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${orderId}-receipt.${ext}"`
  );
}

async function maybeAudit(
  req: NextApiRequest,
  session: AdminSession,
  orderId: string,
  kind: "receipt" | "advance"
): Promise<void> {
  const actorKey = session.isMaster
    ? "master"
    : session.staffId != null
      ? `staff:${session.staffId}`
      : `role:${session.role}`;
  const throttleKey = `receipt_view:${actorKey}:${orderId}:${kind}`;
  const { record } = auditThrottle(throttleKey, AUDIT_WINDOW_MS);
  if (!record) return;
  await recordAudit(pool, {
    actor: session,
    action: "receipt_view",
    entityType: "order",
    entityId: orderId,
    summary: kind === "advance" ? "Viewed advance receipt" : "Viewed payment receipt",
    detail: { kind },
    req,
  });
}

function isLegacyReceiptValue(value: string): boolean {
  if (isOpaqueReceiptRef(value)) return false;
  try {
    const safe = assertSafeReceiptUrl(value);
    return Boolean(safe);
  } catch {
    return false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await requirePermission(req, res, "orders:view");
  if (!session) return;

  const sessionKey = session.isMaster
    ? `master:${session.name}`
    : session.staffId != null
      ? `staff:${session.staffId}`
      : `sess:${session.role}:${session.name}`;
  if (!allowStaffRate(sessionKey)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests" });
  }

  const parsedFile = parseFileParam(req.query.file);
  if (!parsedFile) {
    return res.status(404).json({ error: "Not found" });
  }
  const { orderId, kind, ext: pathExt } = parsedFile;

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT order_id, receipt_path, advance_receipt_path FROM orders WHERE order_id = ? LIMIT 1`,
      [orderId]
    );
    const order = Array.isArray(rows) ? rows[0] : null;
    if (!order) {
      return res.status(404).json({ error: "Not found" });
    }

    const rawPath =
      kind === "advance"
        ? order.advance_receipt_path != null
          ? String(order.advance_receipt_path)
          : ""
        : order.receipt_path != null
          ? String(order.receipt_path)
          : "";
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return res.status(404).json({ error: "Not found" });
    }

    const ref = parseReceiptRef(trimmed);
    if (ref) {
      if (ref.ext !== pathExt) {
        return res.status(404).json({ error: "Not found" });
      }

      if (ref.storage === "loc") {
        const dir = privateReceiptsDir();
        const fileName = `${ref.id}.${ref.ext}`;
        const full = path.resolve(dir, fileName);
        if (path.basename(full) !== fileName || !full.startsWith(path.resolve(dir) + path.sep)) {
          return res.status(404).json({ error: "Not found" });
        }
        if (!fs.existsSync(full)) {
          return res.status(404).json({ error: "Not found" });
        }
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) {
          return res.status(404).json({ error: "Not found" });
        }
        const bytes = fs.readFileSync(full);
        await maybeAudit(req, session, orderId, kind);
        setReceiptHeaders(res, ref.ext, orderId);
        return res.status(200).send(bytes);
      }

      // cld — signed authenticated delivery, fetched server-side only
      const resourceType = ref.ext === "pdf" ? "raw" : "image";
      const publicId = cloudinaryPublicIdForRef(ref.id);
      const sign = injectedSignUrl || defaultSignUrl;
      let signedUrl = "";
      try {
        signedUrl = sign({
          publicId,
          resourceType,
          format: ref.ext,
        });
      } catch {
        return res.status(404).json({ error: "Not found" });
      }
      if (
        typeof signedUrl !== "string" ||
        !signedUrl.startsWith("https://res.cloudinary.com/")
      ) {
        return res.status(404).json({ error: "Not found" });
      }

      const fetchImpl = injectedFetch || (globalThis.fetch as unknown as FetchFn);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let upstream: Awaited<ReturnType<FetchFn>>;
      try {
        upstream = await fetchImpl(signedUrl, { signal: ac.signal });
      } catch {
        clearTimeout(timer);
        return res.status(404).json({ error: "Not found" });
      } finally {
        clearTimeout(timer);
      }
      if (!upstream.ok) {
        return res.status(404).json({ error: "Not found" });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) {
        return res.status(404).json({ error: "Not found" });
      }
      await maybeAudit(req, session, orderId, kind);
      setReceiptHeaders(res, ref.ext, orderId);
      // Never echo signed URL / public_id / signature
      return res.status(200).send(buf);
    }

    // Legacy public Cloudinary URL or /uploads/receipts path — 302 (no behaviour change for old receipts)
    if (!isLegacyReceiptValue(trimmed)) {
      return res.status(404).json({ error: "Not found" });
    }
    let legacyTarget = "";
    try {
      legacyTarget = assertSafeReceiptUrl(trimmed);
    } catch (err) {
      if (err instanceof UrlValidationError) {
        return res.status(404).json({ error: "Not found" });
      }
      throw err;
    }
    if (!legacyTarget) {
      return res.status(404).json({ error: "Not found" });
    }
    await maybeAudit(req, session, orderId, kind);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Location", legacyTarget);
    return res.status(302).end();
  } catch {
    return res.status(500).json({ error: "Unable to load receipt" });
  }
}
