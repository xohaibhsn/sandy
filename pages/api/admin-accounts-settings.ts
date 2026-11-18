import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "../../lib/adminPermissions";
import { loadAccountSettings } from "../../lib/accountSettings";
import { isOtpProviderConfigured } from "../../lib/otp/index";

/**
 * Read-only customer-accounts settings for the super_admin panel.
 * Writes go through POST /api/site-content (settings:accounts).
 * Only a boolean is exposed for the OTP provider — never provider names or credentials.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requirePermission(req, res, "settings:accounts");
  if (!session) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");
  try {
    const settings = await loadAccountSettings();
    return res.status(200).json({
      success: true,
      settings,
      otpProviderConfigured: isOtpProviderConfigured(),
    });
  } catch (err) {
    console.error("[api/admin-accounts-settings] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
