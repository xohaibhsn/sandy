/**
 * Append-only admin activity log (BATCH-20).
 * Never throws into callers: missing table / insert errors are best-effort.
 * Detail is always sanitised before insert. No runtime DDL.
 */
import crypto from "crypto";
import type { NextApiRequest } from "next";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { AdminSession } from "./adminAuth";
import { getClientIp } from "./rateLimit";

export type AuditActorType = "master" | "staff" | "system" | "anonymous";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "status_change"
  | "confirm"
  | "dispatch"
  | "rto"
  | "cancel"
  | "login_success"
  | "login_failed"
  | "logout"
  | "setting_change"
  | "upload"
  | "customer_email_sent"
  | "customer_email_failed"
  | "customer_email_skipped"
  | "store_email_sent"
  | "store_email_failed"
  | "store_email_skipped";

export type AuditActorInput =
  | Pick<AdminSession, "staffId" | "isMaster" | "role" | "name">
  | {
      actorType: AuditActorType;
      staffId?: number | null;
      role?: string | null;
      name?: string | null;
    };

export type AuditEntry = {
  actor: AuditActorInput;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | number | null;
  summary: string;
  detail?: unknown;
  req?: NextApiRequest | null;
  ipHash?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

const DETAIL_MAX_BYTES = 16384;
const SUMMARY_MAX = 300;
const ENTITY_ID_MAX = 120;
const UA_MAX = 200;
const REQUEST_ID_MAX = 40;
const LONG_TEXT = 120;

const REDACT_KEYS = new Set(
  [
    "password",
    "password_hash",
    "upgradedhash",
    "token",
    "rawtoken",
    "session",
    "cookie",
    "authorization",
    "otp",
    "code",
    "otp_code",
    "verification_sid",
    "provider_ref",
    "sid",
    "api_key",
    "apikey",
    "secret",
    "auth_token",
    "authtoken",
    "receipt_url",
    "receipt_path",
    "advance_receipt_path",
    "advance_receipt_url",
    "signed_url",
    "public_id",
    "file",
    "buffer",
    "bytes",
    "data_url",
    "base64",
  ].map((k) => k.toLowerCase())
);

const MASK_PHONE_KEYS = new Set(["phone", "phone_norm", "mobile", "customer_phone"]);
const MASK_EMAIL_KEYS = new Set(["email", "customer_email"]);
const ADDRESS_KEYS = new Set([
  "address",
  "shipping_address",
  "billing_address",
  "customer_address",
  "full_address",
]);
const LONG_TEXT_KEYS = new Set([
  "content",
  "html",
  "body",
  "description",
  "short_description",
  "full_description",
  "features",
  "meta_description",
  "privacy_content",
  "terms_content",
  "refund_content",
  "about_content",
  "answer",
  "faqs",
]);

type Queryable = Pool | PoolConnection;

const NEGATIVE_PROBE_TTL_MS = 60_000;
const AUDIT_THROTTLE_CAP = 2000;

let schemaKnown: boolean | null = null;
let schemaKnownAt = 0;
let schemaWarned = false;
let auditIpHashLegacyWarned = false;

type ThrottleEntry = { windowStart: number; suppressed: number };
const auditThrottleMap = new Map<string, ThrottleEntry>();

export function resetAuditSchemaProbeForTests(): void {
  schemaKnown = null;
  schemaKnownAt = 0;
  schemaWarned = false;
}

export function resetAuditThrottleForTests(): void {
  auditThrottleMap.clear();
}

export function resetAuditIpHashWarnForTests(): void {
  auditIpHashLegacyWarned = false;
}

/** Test-only: seed a cached negative probe with a chosen age. */
export function seedAuditNegativeProbeForTests(ageMs: number): void {
  schemaKnown = false;
  schemaKnownAt = Date.now() - ageMs;
  schemaWarned = true;
}

/** Test-only: inspect probe cache. */
export function getAuditSchemaProbeForTests(): {
  known: boolean | null;
  at: number;
} {
  return { known: schemaKnown, at: schemaKnownAt };
}

/** Test-only: throttle map size (cap eviction). */
export function getAuditThrottleSizeForTests(): number {
  return auditThrottleMap.size;
}

/**
 * In-memory write throttle for noisy audit paths (e.g. login rate_limited).
 * First call in a window → record; later calls increment suppressed; when the
 * window rolls, the next record returns the prior suppressed count.
 * Hard cap 2000 keys; evict oldest insertion first. No timers, no I/O.
 */
export function auditThrottle(
  key: string,
  windowMs: number,
  now = Date.now()
): { record: boolean; suppressed: number } {
  const existing = auditThrottleMap.get(key);
  if (!existing) {
    if (auditThrottleMap.size >= AUDIT_THROTTLE_CAP) {
      const oldest = auditThrottleMap.keys().next().value;
      if (oldest !== undefined) auditThrottleMap.delete(oldest);
    }
    auditThrottleMap.set(key, { windowStart: now, suppressed: 0 });
    return { record: true, suppressed: 0 };
  }
  if (now - existing.windowStart >= windowMs) {
    const suppressed = existing.suppressed;
    existing.windowStart = now;
    existing.suppressed = 0;
    // Refresh insertion order so active keys are not treated as oldest.
    auditThrottleMap.delete(key);
    auditThrottleMap.set(key, existing);
    return { record: true, suppressed };
  }
  existing.suppressed += 1;
  return { record: false, suppressed: existing.suppressed };
}

/**
 * IP hash for audit rows. Optional AUDIT_IP_HASH_KEY (>= 32 chars) → HMAC-SHA256.
 * Otherwise legacy sha256(`audit-ip:${ip}`) for backward compatibility.
 * Env is read at call time (tests may toggle). Never derive from DB_PASSWORD.
 */
export function hashAuditIp(ip: string): string {
  const key = process.env.AUDIT_IP_HASH_KEY;
  if (typeof key === "string" && key.length >= 32) {
    return crypto.createHmac("sha256", key).update(ip).digest("hex");
  }
  if (!auditIpHashLegacyWarned) {
    auditIpHashLegacyWarned = true;
    console.warn("[audit] AUDIT_IP_HASH_KEY not set; using legacy ip hash");
  }
  return crypto.createHash("sha256").update(`audit-ip:${ip}`).digest("hex");
}

export function maskPhone(raw: unknown): string {
  const s = String(raw ?? "").replace(/\D/g, "");
  if (s.length < 4) return "••••";
  const local = s.length === 12 && s.startsWith("92") ? `0${s.slice(2)}` : s;
  const head = local.slice(0, 2);
  const tail = local.slice(-2);
  return `${head}${"•".repeat(Math.max(4, local.length - 4))}${tail}`;
}

export function maskEmail(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "•••@•••";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const first = local[0] || "•";
  return `${first}•••@${domain || "•••"}`;
}

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function keyNorm(k: string): string {
  return k.replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

export function sanitizeAuditValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max-depth]";
  const kn = keyNorm(key);

  // Boolean flags (e.g. selfPasswordChange) are not secret material — keep them.
  if (
    (REDACT_KEYS.has(kn) || kn.includes("password") || kn.endsWith("_sid") || kn.includes("secret")) &&
    typeof value !== "boolean"
  ) {
    return "[redacted]";
  }
  if (MASK_PHONE_KEYS.has(kn) || kn.endsWith("_phone")) return maskPhone(value);
  if (MASK_EMAIL_KEYS.has(kn) || kn.endsWith("_email")) return maskEmail(value);
  if (ADDRESS_KEYS.has(kn) || kn.endsWith("_address")) return "[redacted]";

  if (typeof value === "string") {
    if (LONG_TEXT_KEYS.has(kn) || value.length > LONG_TEXT) {
      if (LONG_TEXT_KEYS.has(kn) || value.length > 240) {
        return { length: value.length, hash: shortHash(value) };
      }
    }
    if (/^data:[^;]+;base64,/i.test(value) || value.length > 2000) {
      return { length: value.length, hash: shortHash(value) };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v, i) => sanitizeAuditValue(String(i), v, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeAuditValue(k, v, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  return String(value);
}

export function sanitizeAuditDetail(detail: unknown): unknown {
  if (detail == null) return null;
  if (Array.isArray(detail) || isPlainObject(detail) || typeof detail === "string") {
    return sanitizeAuditValue("detail", detail);
  }
  return sanitizeAuditValue("detail", { value: detail });
}

export function truncateDetailJson(detail: unknown): string | null {
  if (detail == null) return null;
  let raw = "";
  try {
    raw = JSON.stringify(sanitizeAuditDetail(detail));
  } catch {
    raw = JSON.stringify({ error: "unserialisable" });
  }
  if (!raw) return null;
  const buf = Buffer.from(raw, "utf8");
  if (buf.length <= DETAIL_MAX_BYTES) return raw;
  const cut = buf.subarray(0, DETAIL_MAX_BYTES - 32).toString("utf8");
  return `${cut}…[truncated]`;
}

function isSensitiveField(key: string): boolean {
  const kn = keyNorm(key);
  return (
    REDACT_KEYS.has(kn) ||
    kn.includes("password") ||
    MASK_PHONE_KEYS.has(kn) ||
    MASK_EMAIL_KEYS.has(kn) ||
    ADDRESS_KEYS.has(kn) ||
    kn.endsWith("_sid") ||
    kn.includes("secret") ||
    kn.includes("token")
  );
}

/** Diff helper: only changed keys. Sensitive → "[changed]"; long text → length+hash. */
export function auditFieldDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): Record<string, { from: unknown; to: unknown } | "[changed]"> {
  const a = before || {};
  const b = after || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, { from: unknown; to: unknown } | "[changed]"> = {};
  for (const key of keys) {
    const from = a[key];
    const to = b[key];
    const fromS = JSON.stringify(from ?? null);
    const toS = JSON.stringify(to ?? null);
    if (fromS === toS) continue;
    if (isSensitiveField(key)) {
      out[key] = "[changed]";
      continue;
    }
    const kn = keyNorm(key);
    if (LONG_TEXT_KEYS.has(kn)) {
      out[key] = {
        from:
          typeof from === "string"
            ? { length: from.length, hash: shortHash(from) }
            : sanitizeAuditValue(key, from),
        to:
          typeof to === "string"
            ? { length: to.length, hash: shortHash(to) }
            : sanitizeAuditValue(key, to),
      };
      continue;
    }
    out[key] = {
      from: sanitizeAuditValue(key, from),
      to: sanitizeAuditValue(key, to),
    };
  }
  return out;
}

function resolveActor(actor: AuditActorInput): {
  actor_type: AuditActorType;
  actor_staff_id: number | null;
  actor_name: string | null;
  actor_role: string | null;
} {
  if ("actorType" in actor) {
    return {
      actor_type: actor.actorType,
      actor_staff_id: actor.staffId == null ? null : Number(actor.staffId),
      actor_name: actor.name == null ? null : String(actor.name).slice(0, 120),
      actor_role: actor.role == null ? null : String(actor.role).slice(0, 30),
    };
  }
  if (actor.isMaster) {
    return {
      actor_type: "master",
      actor_staff_id: null,
      actor_name: String(actor.name || "Admin").slice(0, 120),
      actor_role: String(actor.role || "super_admin").slice(0, 30),
    };
  }
  return {
    actor_type: "staff",
    actor_staff_id: actor.staffId == null ? null : Number(actor.staffId),
    actor_name: String(actor.name || "Staff").slice(0, 120),
    actor_role: String(actor.role || "").slice(0, 30) || null,
  };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

export async function auditTableExists(conn: Queryable): Promise<boolean> {
  if (schemaKnown === true) return true;
  if (schemaKnown === false) {
    if (Date.now() - schemaKnownAt < NEGATIVE_PROBE_TTL_MS) return false;
    schemaKnown = null;
  }
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT 1 AS ok
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_audit_log'
       LIMIT 1`
    );
    schemaKnown = Array.isArray(rows) && rows.length > 0;
  } catch {
    schemaKnown = false;
  }
  schemaKnownAt = Date.now();
  if (!schemaKnown && !schemaWarned) {
    schemaWarned = true;
    console.warn("[audit] admin_audit_log missing; writes skipped");
  }
  return !!schemaKnown;
}

function isNoSuchTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1146 || e.code === "ER_NO_SUCH_TABLE";
}

export async function recordAudit(conn: Queryable, entry: AuditEntry): Promise<void> {
  try {
    const exists = await auditTableExists(conn);
    if (!exists) return;

    const actor = resolveActor(entry.actor);
    const summary = clip(String(entry.summary || "").trim() || entry.action, SUMMARY_MAX);
    const entityId =
      entry.entityId == null || entry.entityId === ""
        ? null
        : clip(String(entry.entityId), ENTITY_ID_MAX);
    const detailJson = truncateDetailJson(entry.detail);

    let ipHash = entry.ipHash ?? null;
    let userAgent = entry.userAgent ?? null;
    let requestId = entry.requestId ?? null;
    if (entry.req) {
      try {
        const ip = getClientIp(entry.req);
        if (ip && !ipHash) ipHash = hashAuditIp(ip);
      } catch {
        /* ignore */
      }
      if (!userAgent) {
        const ua = entry.req.headers["user-agent"];
        if (typeof ua === "string" && ua) userAgent = clip(ua, UA_MAX);
      }
      if (!requestId) {
        const rid =
          entry.req.headers["x-request-id"] ||
          entry.req.headers["x-correlation-id"];
        if (typeof rid === "string" && rid) requestId = clip(rid, REQUEST_ID_MAX);
      }
    }

    await conn.query(
      `INSERT INTO admin_audit_log
        (actor_type, actor_staff_id, actor_name, actor_role, action, entity_type, entity_id,
         summary, detail_json, ip_hash, user_agent, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor.actor_type,
        actor.actor_staff_id,
        actor.actor_name,
        actor.actor_role,
        clip(String(entry.action), 40),
        clip(String(entry.entityType), 40),
        entityId,
        summary,
        detailJson,
        ipHash,
        userAgent ? clip(userAgent, UA_MAX) : null,
        requestId ? clip(requestId, REQUEST_ID_MAX) : null,
      ]
    );
  } catch (err) {
    if (isNoSuchTableError(err)) {
      schemaKnown = null;
      schemaKnownAt = 0;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[audit] write failed:", msg);
  }
}

/** Formula-injection safe CSV cell (same rules as orders export). */
export function auditCsvEscapeCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  const first = s.length > 0 ? s[0] : "";
  if (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r"
  ) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
