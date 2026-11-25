import { canonicalPkMobile, digitsOnly } from "./customerIdentity";
import { PAKISTAN_PROVINCES } from "./site";

export type CheckoutContactField =
  | "name"
  | "phone"
  | "email"
  | "address"
  | "city"
  | "province";

export type CheckoutValidationOk = { ok: true };
export type CheckoutValidationFail = {
  ok: false;
  field: CheckoutContactField;
  code: string;
};
export type CheckoutValidationResult = CheckoutValidationOk | CheckoutValidationFail;

/** Default English messages (also CMS defaults for cart_err_*). */
export const CHECKOUT_ERR_REQUIRED = "Please fill in this field.";
export const CHECKOUT_ERR_PHONE =
  "Please enter a valid Pakistani mobile number, e.g. 03XX XXXXXXX.";
export const CHECKOUT_ERR_EMAIL = "Please enter a valid email address.";
export const CHECKOUT_ERR_PROVINCE = "Please select your province.";

const PROVINCE_SET = new Set<string>(PAKISTAN_PROVINCES);

function isNonEmpty(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t : null;
}

/** Syntactic email: one "@", non-empty local, domain with a dot, no spaces, ≤ 254. */
export function isValidCheckoutEmail(raw: string): boolean {
  const email = raw.trim();
  if (!email || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return false;
  if (!domain.includes(".")) return false;
  return true;
}

/**
 * Pure checkout contact validation (D66).
 * Phone: canonicalPkMobile(digitsOnly(trimmed)) !== null.
 * Province must be one of PAKISTAN_PROVINCES.
 */
export function validateCheckoutContact(input: {
  name: unknown;
  phone: unknown;
  email: unknown;
  address: unknown;
  city: unknown;
  province: unknown;
}): CheckoutValidationResult {
  const name = isNonEmpty(input.name);
  if (!name) return { ok: false, field: "name", code: "required" };

  const phoneRaw = isNonEmpty(input.phone);
  if (!phoneRaw) return { ok: false, field: "phone", code: "required" };
  const digits = digitsOnly(phoneRaw);
  if (canonicalPkMobile(digits) === null) {
    return { ok: false, field: "phone", code: "invalid_phone" };
  }

  const emailRaw = isNonEmpty(input.email);
  if (!emailRaw) return { ok: false, field: "email", code: "required" };
  if (!isValidCheckoutEmail(emailRaw)) {
    return { ok: false, field: "email", code: "invalid_email" };
  }

  const address = isNonEmpty(input.address);
  if (!address) return { ok: false, field: "address", code: "required" };

  const city = isNonEmpty(input.city);
  if (!city) return { ok: false, field: "city", code: "required" };

  const province = isNonEmpty(input.province);
  if (!province) return { ok: false, field: "province", code: "required" };
  if (!PROVINCE_SET.has(province)) {
    return { ok: false, field: "province", code: "invalid_province" };
  }

  return { ok: true };
}

export function checkoutErrorMessage(code: string): string {
  switch (code) {
    case "invalid_phone":
      return CHECKOUT_ERR_PHONE;
    case "invalid_email":
      return CHECKOUT_ERR_EMAIL;
    case "invalid_province":
      return CHECKOUT_ERR_PROVINCE;
    case "required":
    default:
      return CHECKOUT_ERR_REQUIRED;
  }
}
