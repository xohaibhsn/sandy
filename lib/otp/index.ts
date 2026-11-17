import crypto from "crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { createMockOtpProvider } from "./mockProvider";
import { createTwilioVerifyProvider } from "./twilioVerifyProvider";
import type { OtpProvider, OtpPurpose } from "./types";

export type { OtpProvider, OtpPurpose } from "./types";

let providerWarningLogged = false;
let cachedProvider: OtpProvider | null | undefined;

/** Test-only. */
export function resetOtpProviderCache(): void {
  cachedProvider = undefined;
  providerWarningLogged = false;
}

export function isOtpProviderConfigured(): boolean {
  const name = String(process.env.OTP_PROVIDER || "").trim();
  if (name === "mock") {
    return process.env.NODE_ENV !== "production";
  }
  if (name === "twilio_verify") {
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_VERIFY_SERVICE_SID
    );
  }
  return false;
}

/**
 * Resolve provider. Returns null when unset / incomplete.
 * Mock refuses production. Logs a one-shot warning when flag callers ask via ensureOtpEffective.
 */
export function getOtpProvider(): OtpProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const name = String(process.env.OTP_PROVIDER || "").trim();
  try {
    if (name === "mock") {
      cachedProvider = createMockOtpProvider();
      return cachedProvider;
    }
    if (name === "twilio_verify") {
      cachedProvider = createTwilioVerifyProvider({
        accountSid: String(process.env.TWILIO_ACCOUNT_SID || ""),
        authToken: String(process.env.TWILIO_AUTH_TOKEN || ""),
        serviceSid: String(process.env.TWILIO_VERIFY_SERVICE_SID || ""),
      });
      return cachedProvider;
    }
  } catch {
    cachedProvider = null;
    return null;
  }
  cachedProvider = null;
  return null;
}

export function otpIsEffective(codOtpEnabled: boolean): boolean {
  if (!codOtpEnabled) return false;
  const ok = isOtpProviderConfigured() && getOtpProvider() !== null;
  if (codOtpEnabled && !ok && !providerWarningLogged) {
    providerWarningLogged = true;
    console.warn("[otp] OTP_PROVIDER_NOT_CONFIGURED");
  }
  return ok;
}

export const OTP_CHALLENGE_TTL_SEC = 10 * 60;
export const OTP_TOKEN_TTL_SEC = 15 * 60;
export const OTP_MAX_ATTEMPTS = 5;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(`otp-ip:${ip}`).digest("hex");
}

export function newChallengeId(): string {
  return crypto.randomUUID();
}

export function newVerificationToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

type Conn = Pool | PoolConnection;

export async function createOtpChallenge(
  conn: Conn,
  input: {
    phoneNorm: string;
    phoneE164: string;
    purpose: OtpPurpose;
    ipHash: string | null;
  }
): Promise<{ challengeId: string; expiresInSec: number }> {
  const provider = getOtpProvider();
  if (!provider) throw new Error("OTP_PROVIDER_NOT_CONFIGURED");

  const { providerRef } = await provider.start(input.phoneE164, input.purpose);
  const challengeId = newChallengeId();
  const expiresInSec = OTP_CHALLENGE_TTL_SEC;

  await conn.query(
    `INSERT INTO otp_challenges
      (id, phone_norm, purpose, provider, provider_ref, status, attempts, ip_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, 'sent', 0, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      challengeId,
      input.phoneNorm,
      input.purpose,
      provider.name,
      providerRef,
      input.ipHash,
      expiresInSec,
    ]
  );

  return { challengeId, expiresInSec };
}

export async function verifyOtpChallenge(
  conn: Conn,
  input: { challengeId: string; code: string }
): Promise<
  | { ok: true; verificationToken: string; expiresInSec: number }
  | { ok: false; code: "INVALID" | "LOCKED" | "EXPIRED" | "NOT_FOUND" }
> {
  const provider = getOtpProvider();
  if (!provider) return { ok: false, code: "NOT_FOUND" };

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, phone_norm, provider_ref, status, attempts, (expires_at <= NOW()) AS is_expired
     FROM otp_challenges WHERE id = ? LIMIT 1 FOR UPDATE`,
    [input.challengeId]
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { ok: false, code: "NOT_FOUND" };

  if (row.status === "failed") return { ok: false, code: "LOCKED" };
  if (row.status !== "sent") return { ok: false, code: "EXPIRED" };

  // Expiry is decided by the database clock (the clock that wrote expires_at), never by comparing a DATETIME
  // parsed in the Node timezone against Date.now(): those disagree whenever the DB and app timezones differ.
  if (Number(row.is_expired) !== 0) {
    await conn.query(`UPDATE otp_challenges SET status = 'expired' WHERE id = ?`, [input.challengeId]);
    return { ok: false, code: "EXPIRED" };
  }

  const attempts = Number(row.attempts || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await conn.query(`UPDATE otp_challenges SET status = 'failed' WHERE id = ?`, [input.challengeId]);
    return { ok: false, code: "LOCKED" };
  }

  const checkTarget = String(row.provider_ref || row.phone_norm || "");
  const good = await provider.check(checkTarget, input.code.trim());
  if (!good) {
    const next = attempts + 1;
    if (next >= OTP_MAX_ATTEMPTS) {
      await conn.query(
        `UPDATE otp_challenges SET attempts = ?, status = 'failed' WHERE id = ?`,
        [next, input.challengeId]
      );
      return { ok: false, code: "LOCKED" };
    }
    await conn.query(`UPDATE otp_challenges SET attempts = ? WHERE id = ?`, [next, input.challengeId]);
    return { ok: false, code: "INVALID" };
  }

  const verificationToken = newVerificationToken();
  const tokenHash = hashToken(verificationToken);
  const expiresInSec = OTP_TOKEN_TTL_SEC;

  await conn.query(
    `UPDATE otp_challenges
     SET status = 'verified',
         verified_at = NOW(),
         verification_token_hash = ?,
         token_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id = ?`,
    [tokenHash, expiresInSec, input.challengeId]
  );

  return { ok: true, verificationToken, expiresInSec };
}

/**
 * Consume a verification token inside an open transaction (FOR UPDATE).
 * Returns the challenge phone_norm on success.
 */
export async function consumeVerificationToken(
  conn: PoolConnection,
  input: { token: string; phoneNorm: string; orderId: string }
): Promise<{ ok: true } | { ok: false; code: "OTP_INVALID" | "OTP_EXPIRED" | "OTP_CONSUMED" | "OTP_PHONE_MISMATCH" }> {
  const tokenHash = hashToken(input.token);
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, phone_norm, status, consumed_at,
            (token_expires_at IS NULL OR token_expires_at <= NOW()) AS token_expired
     FROM otp_challenges
     WHERE verification_token_hash = ?
     LIMIT 1
     FOR UPDATE`,
    [tokenHash]
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { ok: false, code: "OTP_INVALID" };
  if (String(row.phone_norm) !== input.phoneNorm) {
    return { ok: false, code: "OTP_PHONE_MISMATCH" };
  }
  if (row.status === "consumed" || row.consumed_at) {
    return { ok: false, code: "OTP_CONSUMED" };
  }
  if (row.status !== "verified") {
    return { ok: false, code: "OTP_INVALID" };
  }
  if (Number(row.token_expired) !== 0) {
    return { ok: false, code: "OTP_EXPIRED" };
  }

  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE otp_challenges
     SET status = 'consumed', consumed_at = NOW(), consumed_order_id = ?
     WHERE id = ? AND status = 'verified' AND consumed_at IS NULL`,
    [input.orderId, row.id]
  );
  if (!result || Number(result.affectedRows) !== 1) {
    return { ok: false, code: "OTP_CONSUMED" };
  }
  return { ok: true };
}
