/**
 * Twilio Verify failure classification.
 * Public code pages (never echoed to customers):
 * - 60200 Invalid parameter — https://www.twilio.com/docs/api/errors/60200 (HTTP 400)
 * - 60202 Max check attempts — https://www.twilio.com/docs/api/errors/60202 (HTTP 429)
 * - 60203 Max send attempts — https://www.twilio.com/docs/api/errors/60203 (HTTP 429)
 * - 60410 Fraud Guard block — https://www.twilio.com/docs/api/errors/60410
 * - 60605 Geo-Permissions block — https://www.twilio.com/docs/api/errors/60605 (HTTP 403)
 * Unknown codes fall through to the HTTP status class (400/403 destination, 429 attempts).
 */

export type OtpFailureKind = "number_rejected" | "max_attempts" | "start_failed";

export class OtpProviderError extends Error {
  readonly kind: OtpFailureKind;

  constructor(kind: OtpFailureKind) {
    const message =
      kind === "number_rejected"
        ? "OTP_NUMBER_REJECTED"
        : kind === "max_attempts"
          ? "OTP_MAX_ATTEMPTS"
          : "OTP_PROVIDER_START_FAILED";
    super(message);
    this.name = "OtpProviderError";
    this.kind = kind;
  }
}

export function otpFailureKind(err: unknown): OtpFailureKind | null {
  if (err instanceof OtpProviderError) return err.kind;
  return null;
}

const NUMBER_CODES = new Set([60200, 60410, 60605]);
const MAX_CODES = new Set([60202, 60203]);

export function classifyTwilioFailure(
  httpStatus: number,
  code: number | null
): OtpFailureKind | "failed" {
  if (code !== null && NUMBER_CODES.has(code)) return "number_rejected";
  if (code !== null && MAX_CODES.has(code)) return "max_attempts";
  // Same families as 60410 (Fraud Guard) and 60605 (geo permissions) when the exact code is new.
  if (code !== null && ((code >= 60400 && code <= 60499) || (code >= 60600 && code <= 60699))) {
    return "number_rejected";
  }
  if (httpStatus === 400 || httpStatus === 403) return "number_rejected";
  if (httpStatus === 429) return "max_attempts";
  return "failed";
}

/** Reads only a numeric `code`. The Twilio message is discarded. */
export async function readTwilioErrorCode(res: Response): Promise<number | null> {
  try {
    const data = (await res.json()) as { code?: unknown };
    const n = typeof data?.code === "number" ? data.code : Number(data?.code);
    if (Number.isInteger(n)) return n;
  } catch {
    /* non-JSON: caller uses the HTTP status class */
  }
  return null;
}
