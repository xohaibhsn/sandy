import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { loadShippingSettings, resetShippingSettingsCache } from "../../lib/shippingSettings";
import { getShippingReadiness } from "../../lib/shipping";

/**
 * Read-only shipping flag + readiness for the super_admin Shipping panel.
 * Writes go through POST /api/site-content (settings:shipping), which also refuses
 * shipping_enabled = 1 unless exactly one ACTIVE default zone exists.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requirePermission(req, res, "settings:shipping");
  if (!session) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  try {
    // Admin screen must reflect the stored value immediately, not a 10s-old cache entry.
    resetShippingSettingsCache();
    const settings = await loadShippingSettings();
    const readiness = await getShippingReadiness(pool);
    return res.status(200).json({
      success: true,
      settings,
      shipping_enabled: settings.shipping_enabled,
      readiness,
    });
  } catch (err) {
    console.error("[api/admin-shipping-settings] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
