import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "../../lib/adminPermissions";
import { loadOrderProtectionSettings } from "../../lib/orderProtectionSettings";
import { isOtpProviderConfigured } from "../../lib/otp/index";

/**
 * Read-only order-protection settings for the super_admin panel.
 * Writes go through POST /api/site-content (settings:order_protection).
 * Only a boolean is exposed for the OTP provider — never provider names or credentials.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requirePermission(req, res, "settings:order_protection");
  if (!session) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");
  try {
    const settings = await loadOrderProtectionSettings();
    return res.status(200).json({
      success: true,
      settings,
      otpProviderConfigured: isOtpProviderConfigured(),
    });
  } catch (err) {
    console.error("[api/admin-order-protection] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
