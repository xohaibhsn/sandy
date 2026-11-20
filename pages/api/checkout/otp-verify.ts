import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { loadOrderProtectionSettings } from "../../../lib/orderProtectionSettings";
import { otpIsEffective, verifyOtpChallenge } from "../../../lib/otp";
import { otpFailureKind, otpFailureLogParts } from "../../../lib/otp/twilioFailure";
import { auditThrottle, recordAudit } from "../../../lib/auditLog";

const PHONE_LIMIT = 3;
const IP_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;
const AUDIT_WINDOW_MS = 15 * 60 * 1000;

async function auditOtpCheckFailed(
  kind: string,
  httpStatus: number | null,
  twilioCode: number | null,
  req: NextApiRequest
): Promise<void> {
  try {
    const codeKey = twilioCode == null ? "-" : String(twilioCode);
    const { record } = auditThrottle(`otp_check_failed:${kind}:${codeKey}`, AUDIT_WINDOW_MS);
    if (!record) return;
    await recordAudit(pool, {
      actor: { actorType: "system" },
      action: "otp_check_failed",
      entityType: "otp",
      entityId: null,
      summary: "OTP check failed",
      detail: { kind, http: httpStatus, twilio_error: twilioCode },
      req,
    });
  } catch {
    /* best-effort */
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp(req);
  const { allowed: ipOk } = rateLimit(`otp-verify-ip:${ip}`, IP_LIMIT, WINDOW_MS);
  if (!ipOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!challengeId || !/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const settings = await loadOrderProtectionSettings();
  if (!otpIsEffective(settings.cod_otp_enabled)) {
    return res.status(409).json({ error: CUSTOMER_TEXTS.COD_OTP_SEND_FAILED });
  }

  // Rate-limit key includes challenge id (phone-scoped after lookup would need a prior read).
  const { allowed: challengeOk } = rateLimit(
    `otp-verify-challenge:${challengeId}`,
    PHONE_LIMIT * 2,
    WINDOW_MS
  );
  if (!challengeOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await verifyOtpChallenge(connection, { challengeId, code });
    if (!result.ok) {
      await connection.commit();
      if (result.code === "MAX_ATTEMPTS") {
        return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS });
      }
      if (result.code === "NUMBER_REJECTED") {
        return res.status(400).json({ error: CUSTOMER_TEXTS.COD_OTP_NUMBER_REJECTED });
      }
      if (result.code === "LOCKED") {
        return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_LOCKED });
      }
      if (result.code === "EXPIRED") {
        return res.status(409).json({ error: CUSTOMER_TEXTS.COD_OTP_EXPIRED });
      }
      if (result.code === "NOT_FOUND") {
        return res.status(404).json({ error: CUSTOMER_TEXTS.COD_OTP_INVALID });
      }
      return res.status(400).json({ error: CUSTOMER_TEXTS.COD_OTP_INVALID });
    }
    await connection.commit();
    return res.status(200).json({
      verificationToken: result.verificationToken,
      expiresInSec: result.expiresInSec,
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    const parts = otpFailureLogParts(err);
    const kind = otpFailureKind(err) || parts.kind;
    console.error(`[otp] verify failed kind=${kind} http=${parts.http} code=${parts.code}`);
    void auditOtpCheckFailed(kind, parts.httpStatus, parts.twilioCode, req);
    if (kind === "max_attempts") {
      return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS });
    }
    if (kind === "number_rejected") {
      return res.status(400).json({ error: CUSTOMER_TEXTS.COD_OTP_NUMBER_REJECTED });
    }
    return res.status(500).json({ error: "Server error" });
  } finally {
    connection.release();
  }
}
