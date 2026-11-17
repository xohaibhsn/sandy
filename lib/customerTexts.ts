/** Public customer-facing strings for COD protection. Keep in sync with phase0/customer-texts.md. */
export const CUSTOMER_TEXTS = {
  COD_NOT_AVAILABLE:
    "Cash on Delivery isn't available for this order. Please choose an advance payment method.",
  COD_OTP_REQUIRED:
    "Confirm your phone number with a WhatsApp code to place a Cash on Delivery order.",
  COD_OTP_SEND: "Send code on WhatsApp",
  COD_OTP_RESEND: "Resend code",
  COD_OTP_ENTER: "Enter the 6-digit code from WhatsApp",
  COD_OTP_VERIFY: "Verify code",
  COD_OTP_VERIFIED: "Phone confirmed",
  COD_OTP_INVALID: "That code didn't work. Please try again.",
  COD_OTP_LOCKED: "Too many attempts. Request a new code.",
  COD_OTP_EXPIRED: "This code has expired. Request a new one.",
  COD_OTP_SEND_FAILED: "We couldn't send a WhatsApp code right now. Please try again shortly.",
  COD_OTP_RATE_LIMIT: "Too many requests. Please wait and try again.",
  ADVANCE_REFERENCE_LABEL: "Advance payment reference",
  ADVANCE_RECEIPT_LABEL: "Advance payment receipt (optional)",
  ADVANCE_DELIVERY_HINT:
    "To place a Cash on Delivery order, please pay the delivery charge in advance and enter your payment reference.",  ELIGIBILITY_GENERIC: "Some payment methods aren't available for this order.",
  ADMIN_OTP_PROVIDER_MISSING: "OTP provider not configured",
} as const;

export type CustomerTextKey = keyof typeof CUSTOMER_TEXTS;
