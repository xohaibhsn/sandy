/**
 * Opaque payment-receipt references (Finding 64 / RECEIPT-PRIVACY-01).
 * Format: rcpt:v1:<storage>:<id>.<ext>
 * - cld: Cloudinary authenticated asset; id = receipt-<uuid> (no folder)
 * - loc: local private file; id = <uuid>
 * Ext allowlist matches upload-receipt: jpg|png|webp|pdf (no gif).
 */
import path from "path";

export const RECEIPT_REF_MAX_LEN = 120;
export const RECEIPT_REF_EXTS = ["jpg", "png", "webp", "pdf"] as const;
export type ReceiptRefExt = (typeof RECEIPT_REF_EXTS)[number];
export type ReceiptStorage = "cld" | "loc";

export type ParsedReceiptRef = {
  storage: ReceiptStorage;
  id: string;
  ext: ReceiptRefExt;
  raw: string;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXT = "(?:jpg|png|webp|pdf)";
const CLD_ID = `receipt-${UUID}`;
const LOC_ID = UUID;

/** Strict full-string match; no slashes; single extension dot only. */
const RECEIPT_REF_RE = new RegExp(
  `^rcpt:v1:(cld|loc):((?:${CLD_ID})|(?:${LOC_ID}))\\.(${EXT})$`
);

export function isReceiptRefExt(value: string): value is ReceiptRefExt {
  return (RECEIPT_REF_EXTS as readonly string[]).includes(value);
}

export function formatReceiptRef(
  storage: ReceiptStorage,
  id: string,
  ext: ReceiptRefExt
): string {
  const raw = `rcpt:v1:${storage}:${id}.${ext}`;
  if (!parseReceiptRef(raw)) {
    throw new Error("Invalid receipt reference");
  }
  return raw;
}

/**
 * Parse an opaque receipt reference. Returns null when invalid
 * (wrong shape, length, storage/id pairing, traversal chars, etc.).
 */
export function parseReceiptRef(value: unknown): ParsedReceiptRef | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > RECEIPT_REF_MAX_LEN) return null;
  if (/[\\/\s]/.test(raw)) return null;
  if ((raw.match(/\./g) || []).length !== 1) return null;

  const m = RECEIPT_REF_RE.exec(raw);
  if (!m) return null;

  const storage = m[1] as ReceiptStorage;
  const id = m[2];
  const ext = m[3] as ReceiptRefExt;

  if (storage === "cld") {
    if (!new RegExp(`^${CLD_ID}$`).test(id)) return null;
  } else if (storage === "loc") {
    if (!new RegExp(`^${LOC_ID}$`).test(id)) return null;
  } else {
    return null;
  }

  return { storage, id, ext, raw };
}

export function isOpaqueReceiptRef(value: unknown): boolean {
  return parseReceiptRef(value) != null;
}

/** Same-origin staff proxy path for an order receipt (main or advance). */
export function staffReceiptProxyPath(
  orderId: string,
  ext: ReceiptRefExt,
  kind: "receipt" | "advance" = "receipt"
): string {
  const id = String(orderId || "").trim();
  if (!id || /[\\/\s?]/.test(id) || id.length > 64) {
    throw new Error("Invalid order id for receipt proxy");
  }
  if (kind === "advance") return `/api/admin-receipt/${id}-advance.${ext}`;
  return `/api/admin-receipt/${id}.${ext}`;
}

export function cloudinaryPublicIdForRef(id: string): string {
  return `sandy/receipts/${id}`;
}

export function contentTypeForReceiptExt(ext: ReceiptRefExt): string {
  switch (ext) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export function privateReceiptsDir(cwd = process.cwd()): string {
  return path.join(cwd, "private-uploads", "receipts");
}
