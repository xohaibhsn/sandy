/**
 * Sanitise OTP / Twilio env values (trim + one pair of surrounding quotes).
 * Reports names-only diagnostics — never values or lengths beyond ok/bad format.
 */

export type OtpEnvFormat = "ok" | "bad" | "n/a";

export type OtpEnvVarCheck = {
  name: string;
  missing: boolean;
  hadWhitespace: boolean;
  hadQuotes: boolean;
  format: OtpEnvFormat;
};

export type OtpEnvSanitised = {
  provider: string;
  accountSid: string;
  authToken: string;
  serviceSid: string;
  checks: OtpEnvVarCheck[];
};

const ACCOUNT_SID_RE = /^AC[0-9a-fA-F]{32}$/;
const SERVICE_SID_RE = /^VA[0-9a-fA-F]{32}$/;
const AUTH_TOKEN_RE = /^[0-9a-fA-F]{32}$/;

function stripSurroundingQuotes(s: string): { value: string; hadQuotes: boolean } {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return { value: s.slice(1, -1), hadQuotes: true };
    }
  }
  return { value: s, hadQuotes: false };
}

/** Trim ends, then strip ONE pair of surrounding quotes. */
export function sanitiseEnvRaw(raw: string | undefined): {
  value: string;
  missing: boolean;
  hadWhitespace: boolean;
  hadQuotes: boolean;
} {
  if (raw === undefined || raw === null) {
    return { value: "", missing: true, hadWhitespace: false, hadQuotes: false };
  }
  const asString = String(raw);
  const trimmed = asString.trim();
  const hadWhitespace = trimmed !== asString;
  if (!trimmed) {
    return { value: "", missing: true, hadWhitespace, hadQuotes: false };
  }
  const { value, hadQuotes } = stripSurroundingQuotes(trimmed);
  // After quote strip, trim again so `" AC.. "` after outer trim still works once quotes gone.
  const finalValue = value.trim();
  if (!finalValue) {
    return { value: "", missing: true, hadWhitespace: hadWhitespace || value !== finalValue, hadQuotes };
  }
  return {
    value: finalValue,
    missing: false,
    hadWhitespace: hadWhitespace || value !== finalValue,
    hadQuotes,
  };
}

function formatCheck(name: string, value: string, missing: boolean): OtpEnvFormat {
  if (missing) return "n/a";
  if (name === "TWILIO_ACCOUNT_SID") return ACCOUNT_SID_RE.test(value) ? "ok" : "bad";
  if (name === "TWILIO_VERIFY_SERVICE_SID") return SERVICE_SID_RE.test(value) ? "ok" : "bad";
  if (name === "TWILIO_AUTH_TOKEN") return AUTH_TOKEN_RE.test(value) ? "ok" : "bad";
  return "n/a";
}

function checkVar(
  name: string,
  raw: string | undefined,
  withFormat: boolean
): { value: string; check: OtpEnvVarCheck } {
  const s = sanitiseEnvRaw(raw);
  return {
    value: s.value,
    check: {
      name,
      missing: s.missing,
      hadWhitespace: s.hadWhitespace,
      hadQuotes: s.hadQuotes,
      format: withFormat ? formatCheck(name, s.value, s.missing) : "n/a",
    },
  };
}

/**
 * Read OTP_PROVIDER + three TWILIO_* vars through one sanitiser.
 * Returned `checks` never include values — names and flags only.
 */
export function readOtpEnv(env: NodeJS.ProcessEnv = process.env): OtpEnvSanitised {
  const provider = checkVar("OTP_PROVIDER", env.OTP_PROVIDER, false);
  const accountSid = checkVar("TWILIO_ACCOUNT_SID", env.TWILIO_ACCOUNT_SID, true);
  const authToken = checkVar("TWILIO_AUTH_TOKEN", env.TWILIO_AUTH_TOKEN, true);
  const serviceSid = checkVar("TWILIO_VERIFY_SERVICE_SID", env.TWILIO_VERIFY_SERVICE_SID, true);
  return {
    provider: provider.value,
    accountSid: accountSid.value,
    authToken: authToken.value,
    serviceSid: serviceSid.value,
    checks: [provider.check, accountSid.check, authToken.check, serviceSid.check],
  };
}
