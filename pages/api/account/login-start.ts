import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { normalisePhone, phoneToE164 } from "../../../lib/customerIdentity";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import { requireAccountsEnabled } from "../../../lib/accountApi";
import { requireSameOriginCustomerRequest } from "../../../lib/customerAuth";
import { createOtpChallenge, hashIp, otpIsEffective } from "../../../lib/otp";

const PHONE_LIMIT = 3;
const IP_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireAccountsEnabled(res))) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireSameOriginCustomerRequest(req, res)) return;

  const ip = getClientIp(req);
  const { allowed: ipOk } = rateLimit(`account-login-start-ip:${ip}`, IP_LIMIT, WINDOW_MS);
  if (!ipOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_RATE_LIMIT });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const phoneNorm = normalisePhone(body.phone);
  if (!phoneNorm) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { allowed: phoneOk } = rateLimit(
    `account-login-start-phone:${phoneNorm}`,
    PHONE_LIMIT,
    WINDOW_MS
  );
  if (!phoneOk) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_RATE_LIMIT });
  }

  // Accounts are on (gate above) but no usable OTP provider: login cannot work.
  if (!otpIsEffective(true)) {
    return res.status(503).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_UNAVAILABLE });
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
      purpose: "login",
      ipHash: hashIp(ip),
    });
    await connection.commit();
    return res.status(200).json({
      challengeId: result.challengeId,
      expiresInSec: result.expiresInSec,
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* ignore */
    }
    console.error("[api/account/login-start] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_OTP_SEND_FAILED });
  } finally {
    connection.release();
  }
}
