import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import pool from "./db";

export type AdminRole = "super_admin" | "manager" | "writer";

export interface AdminSession {
  role: AdminRole;
  name: string;
  staffId: number | null;
  isMaster: boolean;
  sessionId: number;
}

const COOKIE_NAME = "sAdminSession";
const SESSION_MAX_AGE_SEC = 604800; // 7 days
const TOKEN_HEX_BYTES = 32; // 64 hex chars
const TOKEN_HEX_RE = /^[a-f0-9]{64}$/i;

let sessionsReady = false;
let sessionsInFlight: Promise<void> | null = null;

function isProductionHttps(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  const site = String(process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").toLowerCase();
  return site.startsWith("https://");
}

function cookieSecureFlag(): string {
  return isProductionHttps() ? "; Secure" : "";
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function setSessionCookie(res: NextApiResponse, rawToken: string): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${cookieSecureFlag()}`
  );
}

export function clearSessionCookie(res: NextApiResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag()}`
  );
}

export async function ensureAdminSessionsTable(): Promise<void> {
  if (sessionsReady) return;
  if (!sessionsInFlight) {
    sessionsInFlight = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          token_hash CHAR(64) NOT NULL,
          staff_id INT NULL,
          is_master TINYINT(1) NOT NULL DEFAULT 0,
          role VARCHAR(32) NOT NULL,
          name VARCHAR(255) NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_admin_sessions_token_hash (token_hash),
          KEY idx_admin_sessions_expires_at (expires_at)
        )
      `);
      sessionsReady = true;
    })().catch((err) => {
      sessionsInFlight = null;
      sessionsReady = false;
      throw err;
    });
  }
  await sessionsInFlight;
}

async function bestEffortPurgeExpired(): Promise<void> {
  try {
    await pool.query("DELETE FROM admin_sessions WHERE expires_at <= NOW() LIMIT 100");
  } catch {
    /* ignore */
  }
}

export async function createAdminSession(params: {
  staffId: number | null;
  isMaster: boolean;
  role: AdminRole;
  name: string;
}): Promise<string> {
  await ensureAdminSessionsTable();
  await bestEffortPurgeExpired();

  const rawToken = crypto.randomBytes(TOKEN_HEX_BYTES).toString("hex");
  const tokenHash = hashSessionToken(rawToken);

  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      tokenHash,
      params.staffId,
      params.isMaster ? 1 : 0,
      params.role,
      params.name,
      SESSION_MAX_AGE_SEC,
    ]
  );

  return rawToken;
}

function readRawCookieToken(req: NextApiRequest): string | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw || typeof raw !== "string") return null;
  const token = raw.trim();
  if (!TOKEN_HEX_RE.test(token)) return null;
  return token;
}

function normalizeRole(role: unknown): AdminRole | null {
  if (role === "super_admin" || role === "manager" || role === "writer") return role;
  return null;
}

/**
 * Cookie-only session lookup. Ignores x-admin-session / x-admin-role.
 * error=true means infrastructure failure (fail closed for protected routes).
 */
export async function getAdminSession(req: NextApiRequest): Promise<{
  session: AdminSession | null;
  error: boolean;
}> {
  const rawToken = readRawCookieToken(req);
  if (!rawToken) return { session: null, error: false };

  try {
    await ensureAdminSessionsTable();
    const tokenHash = hashSessionToken(rawToken);
    const [rows] = await pool.query(
      `SELECT id, staff_id, is_master, role, name
       FROM admin_sessions
       WHERE token_hash = ? AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );
    const row = (Array.isArray(rows) ? rows[0] : null) as {
      id: number;
      staff_id: number | null;
      is_master: number;
      role: string;
      name: string;
    } | null;
    if (!row) return { session: null, error: false };

    const isMaster = Number(row.is_master) === 1;
    const sessionId = Number(row.id);

    if (isMaster || row.staff_id == null) {
      const role = normalizeRole(row.role) || "super_admin";
      return {
        session: {
          role,
          name: String(row.name || "Admin"),
          staffId: null,
          isMaster: true,
          sessionId,
        },
        error: false,
      };
    }

    const staffId = Number(row.staff_id);
    const [staffRows] = await pool.query(
      "SELECT id, name, role, active FROM admin_staff WHERE id = ? LIMIT 1",
      [staffId]
    );
    const staff = (Array.isArray(staffRows) ? staffRows[0] : null) as {
      id: number;
      name: string;
      role: string;
      active: number;
    } | null;
    if (!staff || Number(staff.active) !== 1) {
      try {
        await pool.query("DELETE FROM admin_sessions WHERE id = ?", [sessionId]);
      } catch {
        /* ignore */
      }
      return { session: null, error: false };
    }

    const role = normalizeRole(staff.role);
    if (!role) {
      try {
        await pool.query("DELETE FROM admin_sessions WHERE id = ?", [sessionId]);
      } catch {
        /* ignore */
      }
      return { session: null, error: false };
    }

    return {
      session: {
        role,
        name: String(staff.name || row.name || "Admin"),
        staffId,
        isMaster: false,
        sessionId,
      },
      error: false,
    };
  } catch {
    return { session: null, error: true };
  }
}

export async function requireAdmin(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AdminSession | null> {
  const { session, error } = await getAdminSession(req);
  if (error) {
    res.status(503).json({ error: "Service unavailable" });
    return null;
  }
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return session;
}

export async function requireRole(
  req: NextApiRequest,
  res: NextApiResponse,
  roles: AdminRole[]
): Promise<AdminSession | null> {
  const session = await requireAdmin(req, res);
  if (!session) return null;
  if (!roles.includes(session.role)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return session;
}

export async function destroyAdminSession(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const rawToken = readRawCookieToken(req);
  clearSessionCookie(res);
  if (!rawToken) return;
  try {
    await ensureAdminSessionsTable();
    const tokenHash = hashSessionToken(rawToken);
    await pool.query("DELETE FROM admin_sessions WHERE token_hash = ?", [tokenHash]);
  } catch {
    /* still cleared cookie; idempotent */
  }
}
