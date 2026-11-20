/**
 * Map /api/admin-otp-health JSON into a safe UI view (names, flags, hint only).
 */

export type OtpHealthTone = "ok" | "error";

export type OtpHealthView = {
  tone: OtpHealthTone;
  hint: string;
  lines: string[];
};

type CheckLike = {
  name?: unknown;
  missing?: unknown;
  hadWhitespace?: unknown;
  hadQuotes?: unknown;
  format?: unknown;
};

function formatCheckLine(c: CheckLike): string | null {
  if (typeof c.name !== "string" || !c.name.trim()) return null;
  const parts: string[] = [c.missing === true ? "missing" : "present"];
  if (c.hadWhitespace === true) parts.push("whitespace");
  if (c.hadQuotes === true) parts.push("quotes");
  if (c.format === "bad") parts.push("bad-format");
  else if (c.format === "ok") parts.push("ok");
  return `${c.name}: ${parts.join(", ")}`;
}

function fallbackHint(body: Record<string, unknown>): string {
  if (typeof body.hint === "string" && body.hint.trim()) return body.hint.trim();
  if (body.stage === "env") {
    return "OTP provider env incomplete — fix the checks below (no Twilio call made).";
  }
  if (body.ok === true) return "Connected.";
  return "OTP connection check returned not ok.";
}

/**
 * Pure view mapper for the admin OTP connection test response.
 * Never copies values from unexpected fields into the output.
 */
export function otpHealthViewFromBody(body: unknown): OtpHealthView {
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const hint = fallbackHint(data);
  const tone: OtpHealthTone = data.ok === true ? "ok" : "error";

  const rawChecks = Array.isArray(data.checks) ? data.checks : [];
  const lines: string[] = [];
  for (const item of rawChecks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const line = formatCheckLine(item as CheckLike);
    if (line) lines.push(line);
  }

  return { tone, hint, lines };
}
