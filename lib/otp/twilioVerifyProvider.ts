import type { OtpProvider, OtpPurpose } from "./types";

type FetchLike = typeof fetch;

export type TwilioVerifyEnv = {
  accountSid: string;
  authToken: string;
  serviceSid: string;
};

/** Twilio Verification SID: VE + 32 hex chars. Never send these in the To field. */
const VERIFICATION_SID_RE = /^VE[0-9a-fA-F]{32}$/;

/**
 * Twilio Verify API (WhatsApp channel) via plain fetch. No Twilio SDK.
 * Env values must be supplied by the caller (never logged).
 */
export function createTwilioVerifyProvider(
  env: TwilioVerifyEnv,
  fetchImpl: FetchLike = fetch
): OtpProvider {
  const { accountSid, authToken, serviceSid } = env;
  if (!accountSid || !authToken || !serviceSid) {
    throw new Error("OTP_TWILIO_CONFIG_INCOMPLETE");
  }

  const authHeader =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}`;

  return {
    name: "twilio_verify",
    async start(phoneE164: string, purpose: OtpPurpose) {
      void purpose;
      const body = new URLSearchParams({
        To: phoneE164,
        Channel: "whatsapp",
      });
      const res = await fetchImpl(`${base}/Verifications`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!res.ok) {
        throw new Error("OTP_PROVIDER_START_FAILED");
      }
      const data = (await res.json()) as { sid?: string };
      if (!data.sid || typeof data.sid !== "string") {
        throw new Error("OTP_PROVIDER_START_FAILED");
      }
      return { providerRef: data.sid };
    },
    async check(providerRefOrPhone: string, code: string) {
      const body = new URLSearchParams({ Code: code });
      if (VERIFICATION_SID_RE.test(providerRefOrPhone)) {
        body.set("VerificationSid", providerRefOrPhone);
      } else if (providerRefOrPhone) {
        // E.164 phone only — never put a SID in To.
        body.set("To", providerRefOrPhone);
      }
      let res: Response;
      try {
        res = await fetchImpl(`${base}/VerificationCheck`, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });
      } catch {
        return false;
      }
      if (!res.ok) return false;
      try {
        const data = (await res.json()) as { status?: string };
        return data.status === "approved";
      } catch {
        return false;
      }
    },
  };
}
