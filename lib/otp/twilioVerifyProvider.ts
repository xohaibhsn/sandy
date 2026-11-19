import { resolveOtpChannel } from "./channel";
import { classifyTwilioFailure, OtpProviderError, readTwilioErrorCode } from "./twilioFailure";
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
 * Twilio Verify API via plain fetch. No Twilio SDK.
 * Channel comes from OTP_CHANNEL (default sms). Env values are never logged.
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
      const channel = resolveOtpChannel();
      const body = new URLSearchParams({
        To: phoneE164,
        Channel: channel,
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
        const code = await readTwilioErrorCode(res);
        const classified = classifyTwilioFailure(res.status, code);
        throw new OtpProviderError(classified === "failed" ? "start_failed" : classified);
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
      if (!res.ok) {
        const code = await readTwilioErrorCode(res);
        const classified = classifyTwilioFailure(res.status, code);
        if (classified === "number_rejected" || classified === "max_attempts") {
          throw new OtpProviderError(classified);
        }
        return false;
      }
      try {
        const data = (await res.json()) as { status?: string };
        return data.status === "approved";
      } catch {
        return false;
      }
    },
  };
}
