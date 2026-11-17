/**
 * Shared customer identity normalisers (phone + email).
 * Phone PK form matches pages/api/track.ts canonicalPkMobile behaviour exactly.
 */

/** Digits-only helper used by track matching and normalisePhone. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Canonical Pakistani mobile form (03XXXXXXXXX) for digits-only input, or null when the
 * digits are not a recognisable PK mobile number.
 * 0092333... -> 92333...; 92 + 3XXXXXXXXX -> 0 + 3XXXXXXXXX; 3XXXXXXXXX -> 0 + 3XXXXXXXXX; 03XXXXXXXXX stays.
 */
export function canonicalPkMobile(digits: string): string | null {
  let d = digits;
  if (d.startsWith("0092")) d = "92" + d.slice(4);
  if (/^923\d{9}$/.test(d)) return "0" + d.slice(2);
  if (/^3\d{9}$/.test(d)) return "0" + d;
  if (/^03\d{9}$/.test(d)) return d;
  return null;
}

/**
 * Normalise a customer phone for blacklist / risk / OTP.
 * - PK mobiles → 03XXXXXXXXX
 * - Other plausible numbers (≥8 digits) → "+" + digits (marker that it is non-PK normalised)
 * - Improbable / empty → null
 */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40) return null;
  const digits = digitsOnly(trimmed);
  if (!digits) return null;
  if (digits.length > 20) return null;
  const pk = canonicalPkMobile(digits);
  if (pk) return pk;
  if (digits.length >= 8) return `+${digits}`;
  return null;
}

/**
 * Normalise email: trim + lowercase.
 * Gmail / Googlemail: remove dots and +tag in the local part; map googlemail → gmail.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (!local || !domain || domain.includes(" ")) return null;

  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
    if (!local) return null;
  }

  return `${local}@${domain}`;
}

/** E.164-ish for Twilio: PK 03XXXXXXXXX → +923XXXXXXXXX; already "+digits" stays. */
export function phoneToE164(phoneNorm: string): string | null {
  if (!phoneNorm) return null;
  if (phoneNorm.startsWith("+") && /^\+\d{8,20}$/.test(phoneNorm)) return phoneNorm;
  if (/^03\d{9}$/.test(phoneNorm)) return `+92${phoneNorm.slice(1)}`;
  return null;
}
