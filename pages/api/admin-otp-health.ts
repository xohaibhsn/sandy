/**
 * No-SMS OTP connection test for super_admin (settings:order_protection).
 * GET Twilio Verify Service metadata only — never starts a Verification.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { recordAudit } from "../../lib/auditLog";
import { readOtpEnv } from "../../lib/otp/env";
import { hintForOtpHealth } from "../../lib/otp/healthHints";
import { readTwilioErrorCode } from "../../lib/otp/twilioFailure";

type FetchLike = typeof fetch;

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;

const rateMap = new Map<string, { windowStart: number; count: number }>();

/** Test-only injectable fetch (never used in production paths unless set). */
let fetchOverride: FetchLike | null = null;

/** @internal test helper */
export function __setAdminOtpHealthFetchForTests(f: FetchLike | null): void {
  fetchOverride = f;
}

/** @internal test helper */
export function __resetAdminOtpHealthRateLimitForTests(): void {
  rateMap.clear();
}

function rateLimitSession(sessionKey: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(sessionKey);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateMap.set(sessionKey, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

function getFetch(): FetchLike {
  return fetchOverride || fetch;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requirePermission(req, res, "settings:order_protection");
  if (!session) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const sessionKey = `otp-health:${session.sessionId}`;
  if (!rateLimitSession(sessionKey)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const env = readOtpEnv();
  const checks = env.checks.map((c) => ({
    name: c.name,
    missing: c.missing,
    hadWhitespace: c.hadWhitespace,
    hadQuotes: c.hadQuotes,
    format: c.format,
  }));

  const twilioReady =
    env.provider === "twilio_verify" &&
    Boolean(env.accountSid && env.authToken && env.serviceSid);

  if (!twilioReady) {
    const body = { ok: false as const, stage: "env" as const, checks };
    void recordAudit(pool, {
      actor: session,
      action: "setting_check",
      entityType: "otp",
      entityId: null,
      summary: "OTP connection env check",
      detail: { stage: "env", ok: false, http: null, twilio_error: null },
      req,
    });
    return res.status(200).json(body);
  }

  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(env.serviceSid)}`;
  const authHeader =
    "Basic " + Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64");

  let http: number | null = null;
  let code: number | null = null;
  let timedOut = false;
  let networkError = false;
  let serviceFriendlyName: string | null = null;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let resTwilio: Response;
    try {
      resTwilio = await getFetch()(url, {
        method: "GET",
        headers: { Authorization: authHeader },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    http = resTwilio.status;
    if (!resTwilio.ok) {
      code = await readTwilioErrorCode(resTwilio);
    } else {
      try {
        const data = (await resTwilio.json()) as { friendly_name?: unknown };
        if (typeof data?.friendly_name === "string" && data.friendly_name.trim()) {
          serviceFriendlyName = data.friendly_name.trim().slice(0, 80);
        }
      } catch {
        /* ignore body parse */
      }
    }
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String((err as { name?: string }).name) : "";
    if (name === "AbortError" || name === "TimeoutError") timedOut = true;
    else networkError = true;
  }

  const hint = hintForOtpHealth({
    http,
    code,
    timedOut,
    networkError,
    serviceFriendlyName,
  });
  const ok = http === 200 && !timedOut && !networkError;

  void recordAudit(pool, {
    actor: session,
    action: "setting_check",
    entityType: "otp",
    entityId: null,
    summary: "OTP connection Twilio check",
    detail: { stage: "twilio", ok, http, twilio_error: code },
    req,
  });

  return res.status(200).json({
    ok,
    stage: "twilio" as const,
    http,
    code,
    hint,
    checks,
    ...(serviceFriendlyName ? { serviceFriendlyName } : {}),
  });
}
