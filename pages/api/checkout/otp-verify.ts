import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { loadOrderProtectionSettings } from "../../../lib/orderProtectionSettings";
import { otpIsEffective, verifyOtpChallenge } from "../../../lib/otp";

const PHONE_LIMIT = 3;
const IP_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

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
    console.error("[api/checkout/otp-verify] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  } finally {
    connection.release();
  }
}
