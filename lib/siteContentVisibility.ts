/**
 * Site-content keys that must NOT be returned to anonymous GET /api/site-content (D67 / B-01).
 * Authenticated staff sessions still receive the full map (admin Settings tabs).
 */
export const INTERNAL_SITE_CONTENT_KEYS = [
  "advance_delivery_charge",
  "advance_methods",
  "advance_only",
  "cod_advance_delivery_charge",
  "cod_max_open_per_phone",
  "cod_new_customer_cap",
  "cod_otp_enabled",
  "cod_protection_enabled",
  "cod_risk_threshold",
  "cod_risky_mode",
  "customer_email_confirmed_enabled",
  "customer_email_received_enabled",
  "shipping_restrict_to_zones",
] as const;

export type InternalSiteContentKey = (typeof INTERNAL_SITE_CONTENT_KEYS)[number];

const INTERNAL_SET = new Set<string>(INTERNAL_SITE_CONTENT_KEYS);

export function isInternalSiteContentKey(key: string): boolean {
  return INTERNAL_SET.has(key);
}

/** Drop internal keys from a flat content map when the caller is not staff. */
export function filterSiteContentForPublic(
  content: Record<string, string>,
  opts: { isStaff: boolean }
): Record<string, string> {
  if (opts.isStaff) return content;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(content)) {
    if (!INTERNAL_SET.has(k)) out[k] = v;
  }
  return out;
}
