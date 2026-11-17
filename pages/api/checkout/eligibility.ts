import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2";
import pool from "../../../lib/db";
import { getClientIp, rateLimit } from "../../../lib/rateLimit";
import { evaluateCheckoutProtection } from "../../../lib/codProtection";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";
import {
  TAX_CONFIG_UNAVAILABLE_MESSAGE,
  isTaxConfigUnavailableError,
  loadEffectiveTaxConfig,
  toTaxUnavailable,
} from "../../../lib/taxStore";
import {
  normalizeRequestItems,
  calculateCouponDiscount,
  computeOrderTaxTotals,
  type TaxedPricedLineItem,
} from "../../../lib/orderPricing";
import type { TaxDestination } from "../../../lib/taxEngine";

const ELIG_LIMIT = 30;
const ELIG_WINDOW_MS = 15 * 60 * 1000;

function parseDbMoney(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
  return null;
}

function parseTaxClassId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp(req);
  const { allowed } = rateLimit(`elig:${ip}`, ELIG_LIMIT, ELIG_WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: CUSTOMER_TEXTS.COD_OTP_RATE_LIMIT });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!phone || !email) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const normalized = normalizeRequestItems(body.items);
  if (!normalized.ok) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const couponInput =
    typeof body.couponCode === "string" ? body.couponCode.trim().toUpperCase() : "";
  let destination: TaxDestination = "domestic";
  if (body.destination === "international" || body.destination === "domestic") {
    destination = body.destination;
  }

  try {
    let config: Awaited<ReturnType<typeof loadEffectiveTaxConfig>>;
    try {
      config = await loadEffectiveTaxConfig(pool, new Date());
    } catch (err) {
      const unavailable = toTaxUnavailable(err, "eligibility:loadEffectiveTaxConfig");
      return res.status(503).json({ error: unavailable.message });
    }

    const ids = normalized.items.map((i) => i.id);
    const placeholders = ids.map(() => "?").join(",");
    const [productRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, price, active, tax_class_id FROM products WHERE id IN (${placeholders})`,
      ids
    );
    const byId = new Map<number, RowDataPacket>();
    for (const row of productRows || []) byId.set(Number(row.id), row);
    if (byId.size !== ids.length) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const items: TaxedPricedLineItem[] = [];
    for (const reqItem of normalized.items) {
      const p = byId.get(reqItem.id);
      if (!p || (p.active !== null && p.active !== undefined && Number(p.active) !== 1)) {
        return res.status(400).json({ error: "Invalid request" });
      }
      const price = parseDbMoney(p.price);
      if (price === null) return res.status(500).json({ error: "Server error" });
      items.push({
        product_id: reqItem.id,
        product_name: String(p.name ?? ""),
        price,
        quantity: reqItem.qty,
        tax_class_id: parseTaxClassId(p.tax_class_id),
      });
    }

    const shipping = 0;
    const goodsSubtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    let discount = 0;

    if (couponInput) {
      try {
        const [couponRows] = await pool.query<RowDataPacket[]>(
          `SELECT code, type, value, minimum_order, usage_limit, used_count, expires_at, is_active
           FROM coupons WHERE code = ?`,
          [couponInput]
        );
        const coupon = couponRows?.[0];
        if (coupon && Number(coupon.is_active) === 1) {
          const base = Math.round((goodsSubtotal + shipping) * 100) / 100;
          const couponValue = parseDbMoney(coupon.value);
          if (couponValue !== null) {
            const d = calculateCouponDiscount(base, coupon.type, couponValue);
            if (d.ok) discount = d.discount_amount;
          }
        }
      } catch {
        /* coupons table optional for eligibility soft path */
      }
    }

    const result = computeOrderTaxTotals({
      items,
      discountAmount: discount,
      shipping,
      config,
      destination,
    });
    if (!result.ok) {
      if (result.error.startsWith("Tax ")) {
        return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
      }
      return res.status(500).json({ error: "Server error" });
    }

    const eval_ = await evaluateCheckoutProtection(pool, {
      phone,
      email,
      orderTotal: result.totals.total,
      clientIp: ip,
    });

    return res.status(200).json({
      allowedMethods: eval_.risk.allowedMethods,
      codAllowed: eval_.risk.codAllowed,
      otpRequired: eval_.risk.otpRequired,
      advanceDeliveryCharge: eval_.risk.advanceDeliveryChargeRequired
        ? eval_.risk.advanceDeliveryCharge
        : undefined,
      messageKey: eval_.risk.codAllowed ? undefined : "ELIGIBILITY_GENERIC",
      message: eval_.risk.codAllowed ? undefined : CUSTOMER_TEXTS.ELIGIBILITY_GENERIC,
    });
  } catch (err) {
    if (isTaxConfigUnavailableError(err)) {
      return res.status(503).json({ error: TAX_CONFIG_UNAVAILABLE_MESSAGE });
    }
    console.error("[api/checkout/eligibility] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
