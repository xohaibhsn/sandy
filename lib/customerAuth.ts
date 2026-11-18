import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "./db";

export interface CustomerRecord {
  id: number;
  phone_norm: string;
  email: string | null;
  name: string | null;
  status: "active" | "disabled";
}

const COOKIE_NAME = "sCustomerSession";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days
const TOKEN_HEX_BYTES = 32;
const TOKEN_HEX_RE = /^[a-f0-9]{64}$/i;

type Conn = Pool | PoolConnection;

function isProductionHttps(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  const site = String(process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").toLowerCase();
  return site.startsWith("https://");
}

function cookieSecureFlag(): string {
  return isProductionHttps() ? "; Secure" : "";
}

export function hashCustomerSessionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function setCustomerSessionCookie(res: NextApiResponse, rawToken: string): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${cookieSecureFlag()}`
  );
}

export function clearCustomerSessionCookie(res: NextApiResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag()}`
  );
}

async function bestEffortPurgeExpired(conn: Conn = pool): Promise<void> {
  try {
    await conn.query("DELETE FROM customer_sessions WHERE expires_at <= NOW() LIMIT 100");
  } catch {
    /* ignore */
  }
}

function readRawCookieToken(req: NextApiRequest): string | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw || typeof raw !== "string") return null;
  const token = raw.trim();
  if (!TOKEN_HEX_RE.test(token)) return null;
  return token;
}

/**
 * Create a new customer session. Rotates: deletes prior sessions for this customer first.
 * Returns the raw token for the cookie (never store raw).
 */
export async function createCustomerSession(
  customerId: number,
  conn: Conn = pool
): Promise<string> {
  await bestEffortPurgeExpired(conn);
  await conn.query("DELETE FROM customer_sessions WHERE customer_id = ?", [customerId]);

  const rawToken = crypto.randomBytes(TOKEN_HEX_BYTES).toString("hex");
  const tokenHash = hashCustomerSessionToken(rawToken);

  await conn.query(
    `INSERT INTO customer_sessions (token_hash, customer_id, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [tokenHash, customerId, SESSION_MAX_AGE_SEC]
  );

  return rawToken;
}

/**
 * Cookie-only session lookup. Never mixes with admin sessions.
 * error=true means infrastructure failure (fail closed for protected routes).
 */
export async function getCustomerSession(req: NextApiRequest): Promise<{
  customer: CustomerRecord | null;
  error: boolean;
}> {
  const rawToken = readRawCookieToken(req);
  if (!rawToken) return { customer: null, error: false };

  try {
    const tokenHash = hashCustomerSessionToken(rawToken);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.id AS session_id, c.id, c.phone_norm, c.email, c.name, c.status
       FROM customer_sessions s
       INNER JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = ? AND s.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { customer: null, error: false };

    const status = String(row.status || "") === "disabled" ? "disabled" : "active";
    if (status !== "active") {
      try {
        await pool.query("DELETE FROM customer_sessions WHERE id = ?", [row.session_id]);
      } catch {
        /* ignore */
      }
      return { customer: null, error: false };
    }

    return {
      customer: {
        id: Number(row.id),
        phone_norm: String(row.phone_norm || ""),
        email: row.email != null ? String(row.email) : null,
        name: row.name != null ? String(row.name) : null,
        status: "active",
      },
      error: false,
    };
  } catch {
    return { customer: null, error: true };
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function headerList(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return [];
}

function normalizeRequestHost(value: string | string[] | undefined): string | null {
  const parts = headerList(value);
  if (parts.length !== 1) return null;
  const host = parts[0].trim().toLowerCase();
  if (!host || host.length > 255 || /[\s/\\@]/.test(host)) return null;
  return host;
}

function forwardedProto(req: NextApiRequest): "http" | "https" | null {
  const parts = headerList(req.headers["x-forwarded-proto"]);
  if (parts.length === 0) return null;
  const first = parts[0].split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return null;
  if (first === "http" || first === "https") return first;
  return null;
}

function forwardedProtoPresent(req: NextApiRequest): boolean {
  return headerList(req.headers["x-forwarded-proto"]).some((part) => part.trim() !== "");
}

function explicitCrossSite(req: NextApiRequest): boolean {
  const parts = headerList(req.headers["sec-fetch-site"]);
  if (parts.length === 0) return false;
  const first = parts[0].split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "cross-site";
}

function provenanceMatches(raw: string, host: string, proto: "http" | "https" | null): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.host.toLowerCase() !== host) return false;
  if (proto === "https" && url.protocol !== "https:") return false;
  if (proto === "http" && url.protocol !== "http:") return false;
  return true;
}

function forbidCrossOrigin(res: NextApiResponse): false {
  res.status(403).json({ error: "Forbidden" });
  return false;
}

export function requireSameOriginCustomerRequest(
  req: NextApiRequest,
  res: NextApiResponse
): boolean {
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return true;

  try {
    if (explicitCrossSite(req)) return forbidCrossOrigin(res);

    const host = normalizeRequestHost(req.headers.host);
    if (!host) return forbidCrossOrigin(res);

    if (forwardedProtoPresent(req)) {
      const proto = forwardedProto(req);
      if (!proto) return forbidCrossOrigin(res);
      return provenanceOk(req, res, host, proto);
    }

    return provenanceOk(req, res, host, null);
  } catch {
    return forbidCrossOrigin(res);
  }
}

function provenanceOk(
  req: NextApiRequest,
  res: NextApiResponse,
  host: string,
  proto: "http" | "https" | null
): boolean {
  const originParts = headerList(req.headers.origin);
  if (originParts.length > 1) return forbidCrossOrigin(res);
  const origin = originParts.length === 1 ? originParts[0].trim() : "";

  if (origin) {
    if (origin.toLowerCase() === "null") return forbidCrossOrigin(res);
    if (!provenanceMatches(origin, host, proto)) return forbidCrossOrigin(res);
    return true;
  }

  const refererParts = headerList(req.headers.referer);
  if (refererParts.length > 1) return forbidCrossOrigin(res);
  const referer = refererParts.length === 1 ? refererParts[0].trim() : "";
  if (!referer) return forbidCrossOrigin(res);
  if (!provenanceMatches(referer, host, proto)) return forbidCrossOrigin(res);
  return true;
}

export async function requireCustomer(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<CustomerRecord | null> {
  if (!requireSameOriginCustomerRequest(req, res)) return null;
  const { customer, error } = await getCustomerSession(req);
  if (error) {
    res.status(503).json({ error: "Service unavailable" });
    return null;
  }
  if (!customer) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return customer;
}

export async function destroyCustomerSession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const rawToken = readRawCookieToken(req);
  clearCustomerSessionCookie(res);
  if (!rawToken) return;
  try {
    const tokenHash = hashCustomerSessionToken(rawToken);
    await pool.query("DELETE FROM customer_sessions WHERE token_hash = ?", [tokenHash]);
  } catch {
    /* still cleared cookie; idempotent */
  }
}

export async function revokeAllCustomerSessions(
  customerId: number,
  conn: Conn = pool
): Promise<void> {
  await conn.query("DELETE FROM customer_sessions WHERE customer_id = ?", [customerId]);
}

export { COOKIE_NAME as CUSTOMER_SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC as CUSTOMER_SESSION_MAX_AGE_SEC };
