import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { normalisePhone, phoneToE164 } from "../../../lib/customerIdentity";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { loadOrderProtectionSettings } from "../../../lib/orderProtectionSettings";
import { resolveOtpChannel } from "../../../lib/otp/channel";
import {
  createOtpChallenge,
  hashIp,
  otpIsEffective,
} from "../../../lib/otp";
import { otpFailureKind, otpFailureLogParts } from "../../../lib/otp/twilioFailure";
import { auditThrottle, recordAudit } from "../../../lib/auditLog";

const PHONE_LIMIT = 3;
const IP_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;
const AUDIT_WINDOW_MS = 15 * 60 * 1000;

async function auditOtpSendFailed(
  kind: string,
  httpStatus: number | null,
  twilioCode: number | null,
  req: NextApiRequest
): Promise<void> {
  try {
    const codeKey = twilioCode == null ? "-" : String(twilioCode);
    const { record } = auditThrottle(`otp_send_failed:${kind}:${codeKey}`, AUDIT_WINDOW_MS);
    if (!record) return;
    await recordAudit(pool, {
      actor: { actorType: "system" },
      action: "otp_send_failed",
      entityType: "otp",
      entityId: null,
      summary: "OTP send failed",
      detail: { kind, http: httpStatus, code: twilioCode },
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
  const { allowed: ipOk } = rateLimit(`otp-start-ip:${ip}`, IP_LIMIT, WINDOW_MS);
  if (!ipOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const phoneNorm = normalisePhone(body.phone);
  if (!phoneNorm) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { allowed: phoneOk } = rateLimit(`otp-start-phone:${phoneNorm}`, PHONE_LIMIT, WINDOW_MS);
  if (!phoneOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
  }

  const settings = await loadOrderProtectionSettings();
  if (!otpIsEffective(settings.cod_otp_enabled)) {
    return res.status(409).json({ error: CUSTOMER_TEXTS.COD_OTP_SEND_FAILED });
  }

  const e164 = phoneToE164(phoneNorm);
  if (!e164) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await createOtpChallenge(connection, {
      phoneNorm,
      phoneE164: e164,
      purpose: "cod_checkout",
      ipHash: hashIp(ip),
    });
    await connection.commit();
    return res.status(200).json({
      challengeId: result.challengeId,
      expiresInSec: result.expiresInSec,
      channel: resolveOtpChannel(),
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    const parts = otpFailureLogParts(err);
    const kind = otpFailureKind(err) || parts.kind;
    console.error(`[otp] start failed kind=${kind} http=${parts.http} code=${parts.code}`);
    void auditOtpSendFailed(kind, parts.httpStatus, parts.twilioCode, req);
    if (kind === "max_attempts") {
      return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_MAX_ATTEMPTS });
    }
    if (kind === "number_rejected") {
      return res.status(400).json({ error: CUSTOMER_TEXTS.COD_OTP_NUMBER_REJECTED });
    }
    return res.status(500).json({ error: CUSTOMER_TEXTS.COD_OTP_SEND_FAILED });
  } finally {
    connection.release();
  }
}
