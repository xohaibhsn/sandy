import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../lib/db";
import { requirePermission } from "../../lib/adminPermissions";
import { loadShippingSettings, resetShippingSettingsCache } from "../../lib/shippingSettings";
import {
  canEnableShipping,
  getDeliveryOpsReadiness,
  getShippingReadiness,
  hasListedCitiesOrProvinces,
  loadShippingZones,
} from "../../lib/shipping";
import type { RowDataPacket } from "mysql2/promise";

/**
 * Read-only shipping flags + readiness for the super_admin Shipping panel.
 * Writes go through POST /api/site-content (settings:shipping).
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
    const deliveryOps = await getDeliveryOpsReadiness(pool);

    let listedCoverage = false;
    let activePickupPoints = 0;
    try {
      if (readiness.tables) {
        const zones = await loadShippingZones(pool);
        listedCoverage = hasListedCitiesOrProvinces(zones);
      }
    } catch {
      listedCoverage = false;
    }
    try {
      if (deliveryOps.schema) {
        const [rows] = await pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS c FROM pickup_points WHERE active = 1"
        );
        activePickupPoints = Number((Array.isArray(rows) ? rows[0]?.c : 0) || 0);
      }
    } catch {
      activePickupPoints = 0;
    }

    const shippingReady = canEnableShipping({
      activeDefaultZones: readiness.activeDefaultZones,
      restrictOn: settings.shipping_restrict_to_zones,
      activeZones: deliveryOps.activeZones,
    });

    return res.status(200).json({
      success: true,
      settings,
      shipping_enabled: settings.shipping_enabled,
      shipping_areas_enabled: settings.shipping_areas_enabled,
      shipping_restrict_to_zones: settings.shipping_restrict_to_zones,
      pickup_enabled: settings.pickup_enabled,
      readiness: {
        ...readiness,
        ready: readiness.tables && readiness.orderColumns && readiness.requiresShippingColumn && shippingReady,
      },
      delivery_ops: {
        ...deliveryOps,
        listed_coverage: listedCoverage,
        active_pickup_points: activePickupPoints,
      },
    });
  } catch (err) {
    console.error("[api/admin-shipping-settings] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
