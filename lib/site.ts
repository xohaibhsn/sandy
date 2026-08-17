export const SITE_NAME = "Sandy";
export const SITE_URL = "https://sandy.com.pk";
export const CURRENCY_SYMBOL = "Rs.";
export const CURRENCY_CODE = "PKR";
export const TAX_RATE = 0.18;
export const TAX_LABEL = "GST (18%)";

export const SITE_NAME_CAPS = "SANDY";
export const FOOTER_COPY = "© 2026 Sandy. All rights reserved.";
export const CONTACT_EMAIL = "info@sandy.com.pk";
export const ORDERS_FROM_EMAIL = "noreply@sandy.com.pk";
export const WHATSAPP_DIGITS = "923334800181";
export const PHONE_DISPLAY = "+923334800181";
export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_DIGITS}`;
export const CONTACT_ADDRESS = "Lahore, Pakistan";
export const CLOUDINARY_FOLDER = "sandy";

export const PAKISTAN_PROVINCES = [
  "Punjab",
  "Sindh",
  "KPK",
  "Balochistan",
  "Islamabad",
  "Gilgit-Baltistan",
  "AJK",
] as const;

/** Parse a PKR amount from DB numbers or strings like "Rs. 999" / "4,999". */
export function parsePrice(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const stripped = raw
    .replace(/Rs\.?/gi, "")
    .replace(/PKR/gi, "")
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "")
    .trim();
  const n = Number(stripped);
  return Number.isFinite(n) ? n : 0;
}

export function formatPrice(amount: number | string): string {
  return `Rs. ${parsePrice(amount).toLocaleString("en-PK")}`;
}

export function absoluteUrl(path = ""): string {
  if (!path) return SITE_URL;
  if (path.startsWith("http")) return path;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
