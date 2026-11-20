import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { normaliseEmail } from "../../../lib/customerIdentity";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { requireAccountsEnabled } from "../../../lib/accountApi";
import {
  createCustomerSession,
  requireSameOriginCustomerRequest,
  setCustomerSessionCookie,
} from "../../../lib/customerAuth";
import { otpIsEffective, verifyOtpChallenge } from "../../../lib/otp";

const PHONE_LIMIT = 3;
const IP_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;
const NAME_MAX = 255;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireAccountsEnabled(res))) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireSameOriginCustomerRequest(req, res)) return;

  const ip = getClientIp(req);
  const { allowed: ipOk } = rateLimit(`account-login-verify-ip:${ip}`, IP_LIMIT, WINDOW_MS);
  if (!ipOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_RATE_LIMIT });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!challengeId || !/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Optional profile hints. Validated BEFORE the OTP is spent so a bad email cannot burn a code.
  let name: string | null = null;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string") return res.status(400).json({ error: "Invalid request" });
    const trimmed = body.name.trim();
    if (trimmed.length > NAME_MAX) return res.status(400).json({ error: "Invalid request" });
    name = trimmed || null;
  }
  let email: string | null = null;
  let emailNorm: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    if (typeof body.email !== "string") return res.status(400).json({ error: "Invalid request" });
    emailNorm = normaliseEmail(body.email);
    if (!emailNorm) return res.status(400).json({ error: "Invalid request" });
    email = body.email.trim();
  }

  if (!otpIsEffective(true)) {
    return res.status(503).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_UNAVAILABLE });
  }

  const { allowed: challengeOk } = rateLimit(
    `account-login-verify-challenge:${challengeId}`,
    PHONE_LIMIT * 2,
    WINDOW_MS
  );
  if (!challengeOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_RATE_LIMIT });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await verifyOtpChallenge(connection, { challengeId, code });
    if (!result.ok) {
      // Commit so attempt counters / expiry transitions persist.
      await connection.commit();
      if (result.code === "MAX_ATTEMPTS") {
        return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_MAX_ATTEMPTS });
      }
      if (result.code === "NUMBER_REJECTED") {
        return res.status(400).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_NUMBER_REJECTED });
      }
      if (result.code === "LOCKED") {
        return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_LOCKED });
      }
      if (result.code === "EXPIRED") {
        return res.status(409).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_EXPIRED });
      }
      if (result.code === "NOT_FOUND") {
        return res.status(404).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
      }
      return res.status(400).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
    }

    const [challengeRows] = await connection.query<RowDataPacket[]>(
      `SELECT purpose, phone_norm FROM otp_challenges WHERE id = ? LIMIT 1`,
      [challengeId]
    );
    const challenge = Array.isArray(challengeRows) ? challengeRows[0] : undefined;
    const phoneNorm = challenge ? String(challenge.phone_norm || "") : "";
    if (!challenge || String(challenge.purpose) !== "login" || !phoneNorm) {
      // Wrong-purpose (e.g. COD checkout) challenge: undo the verification, never create a session.
      await connection.rollback();
      return res.status(400).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_INVALID });
    }

    await connection.query(
      `INSERT INTO customers (phone_norm, name, email, email_norm, last_login_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         last_login_at = NOW(),
         name = COALESCE(VALUES(name), name),
         email = COALESCE(VALUES(email), email),
         email_norm = COALESCE(VALUES(email_norm), email_norm)`,
      [phoneNorm, name, email, emailNorm]
    );

    const [customerRows] = await connection.query<RowDataPacket[]>(
      `SELECT id, status FROM customers WHERE phone_norm = ? LIMIT 1`,
      [phoneNorm]
    );
    const customer = Array.isArray(customerRows) ? customerRows[0] : undefined;
    if (!customer) {
      await connection.rollback();
      return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
    }
    if (String(customer.status || "") === "disabled") {
      await connection.rollback();
      return res.status(403).json({ error: "Forbidden" });
    }

    // Rotates: removes any prior sessions for this customer.
    const rawToken = await createCustomerSession(Number(customer.id), connection);
    await connection.commit();
    setCustomerSessionCookie(res, rawToken);
    return res.status(200).json({ ok: true });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    console.error("[api/account/login-verify] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
  } finally {
    connection.release();
  }
}
