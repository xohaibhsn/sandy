/**
 * Map Twilio Verify service GET outcomes to operator hints (no secrets).
 */

export type OtpHealthHintInput = {
  http: number | null;
  code: number | null;
  timedOut?: boolean;
  networkError?: boolean;
  serviceFriendlyName?: string | null;
};

export function hintForOtpHealth(input: OtpHealthHintInput): string {
  if (input.timedOut || input.networkError) {
    return "Could not reach Twilio";
  }
  const http = input.http;
  const code = input.code;
  if (http === 401 || code === 20003) {
    return "Authentication failed: check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (use the LIVE credentials from Twilio Console -> Account Info)";
  }
  if (http === 403 || code === 20008) {
    return "These look like Twilio TEST credentials; use the LIVE Account SID and Auth Token";
  }
  if (http === 404 || code === 20404) {
    return "Verify Service SID not found in this Twilio account";
  }
  if (http === 200) {
    const name = (input.serviceFriendlyName || "").trim() || "service";
    return `Connected to Twilio Verify service ${name}`;
  }
  const codePart = code == null ? "unknown" : String(code);
  const httpPart = http == null ? "unknown" : String(http);
  return `Twilio error ${codePart} (HTTP ${httpPart})`;
}
