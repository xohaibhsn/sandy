import type { OtpChannel } from "./channel";

/** Mask a phone for on-screen copy. Keeps two leading and two trailing digits. */
export function maskPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  const head = digits.slice(0, 2);
  const tail = digits.slice(-2);
  const dots = "•".repeat(Math.min(6, Math.max(2, digits.length - 4)));
  return `${head}${dots}${tail}`;
}

/**
 * Post-send customer line.
 * SMS names the channel and a masked number. WhatsApp stays neutral ("to your phone").
 */
export function otpCodeSentText(channel: OtpChannel | string | undefined, phone: string): string {
  if (channel === "whatsapp") return "We sent a 6-digit code to your phone.";
  return `We sent a 6-digit code by SMS to ${maskPhoneForDisplay(phone)}.`;
}
