export type OtpChannel = "sms" | "whatsapp";

let channelWarningLogged = false;

/** Test-only. */
export function resetOtpChannelWarning(): void {
  channelWarningLogged = false;
}

/**
 * OTP delivery channel for Twilio Verify.
 * Unset or "sms" -> sms. "whatsapp" is an explicit fallback only.
 * Any other value defaults to sms and logs one warning that does not include the value.
 */
export function resolveOtpChannel(): OtpChannel {
  const raw = String(process.env.OTP_CHANNEL ?? "").trim().toLowerCase();
  if (raw === "" || raw === "sms") return "sms";
  if (raw === "whatsapp") return "whatsapp";
  if (!channelWarningLogged) {
    channelWarningLogged = true;
    console.warn("[otp] OTP_CHANNEL_INVALID");
  }
  return "sms";
}
