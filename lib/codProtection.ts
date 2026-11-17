/**
 * Shared COD-protection evaluation used by eligibility + orders.
 */
import type { Pool, PoolConnection } from "mysql2/promise";
import {
  evaluateCodRisk,
  loadBlacklistHit,
  loadCodRiskHistory,
  loadIpOrderCount24h,
  type CodRiskResult,
} from "./codRisk";
import { normaliseEmail, normalisePhone } from "./customerIdentity";
import {
  loadOrderProtectionSettings,
  type OrderProtectionSettings,
} from "./orderProtectionSettings";
import { hashIp, otpIsEffective } from "./otp";

export type ProtectionEval = {
  settings: OrderProtectionSettings;
  phoneNorm: string | null;
  emailNorm: string | null;
  risk: CodRiskResult;
  otpEffective: boolean;
};

/** When protection is OFF, checkout offers every method (independent of advance_methods). */
export const ALLOWED_METHODS_WHEN_PROTECTION_OFF = ["cod", "jazzcash", "easypaisa", "bank"] as const;

export async function evaluateCheckoutProtection(
  conn: Pool | PoolConnection,
  input: {
    phone: string;
    email: string;
    orderTotal: number;
    paymentMethod?: string;
    clientIp?: string;
  }
): Promise<ProtectionEval> {
  const settings = await loadOrderProtectionSettings();
  const phoneNorm = normalisePhone(input.phone);
  const emailNorm = normaliseEmail(input.email);
  const otpEffective = otpIsEffective(settings.cod_otp_enabled);

  if (!settings.cod_protection_enabled) {
    // Protection OFF: identical to today — all four methods, ignore advance_methods setting.
    return {
      settings,
      phoneNorm,
      emailNorm,
      otpEffective: false,
      risk: {
        score: 0,
        reasons: [],
        codAllowed: true,
        allowedMethods: [...ALLOWED_METHODS_WHEN_PROTECTION_OFF],
        otpRequired: false,
        advanceDeliveryChargeRequired: false,
        advanceDeliveryCharge: 0,
      },
    };
  }

  const ipHash = input.clientIp ? hashIp(input.clientIp) : null;
  const [history, blacklistHit, ipOrderCount24h] = await Promise.all([
    loadCodRiskHistory(conn, phoneNorm),
    loadBlacklistHit(conn, phoneNorm, emailNorm),
    loadIpOrderCount24h(conn, ipHash),
  ]);

  const risk = evaluateCodRisk({
    phoneNorm,
    emailNorm,
    orderTotal: input.orderTotal,
    paymentMethod: input.paymentMethod || "cod",
    history,
    blacklistHit,
    ipOrderCount24h,
    settings,
    otpEffective,
  });

  return { settings, phoneNorm, emailNorm, risk, otpEffective };
}
