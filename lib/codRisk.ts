/**
 * Pure COD risk scoring + method gating (D29–D31).
 * DB-reading wrapper lives in evaluateCodRiskFromDb.
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { AdvanceMethod, OrderProtectionSettings, RiskyMode } from "./orderProtectionSettings";
import { hasRtoColumn, resetRtoColumnCache } from "./shippingSchema";

/** Test-only: reset the cached orders.rto probe (re-exported from lib/shippingSchema.ts). */
export { resetRtoColumnCache };

export type RiskReasonCode =
  | "BLACKLIST"
  | "NEW_CUSTOMER"
  | "OVER_CAP"
  | "OPEN_COD"
  | "CANCEL_HISTORY"
  | "REFUSED_HISTORY"
  | "IP_BURST"
  | "TRUSTED_DELIVERED"
  | "RISKY_THRESHOLD";

export const RISK_REASON_LABELS: Readonly<Record<RiskReasonCode, string>> = {
  BLACKLIST: "Blacklist match",
  NEW_CUSTOMER: "New customer",
  OVER_CAP: "Over new-customer COD cap",
  OPEN_COD: "Open COD order limit",
  CANCEL_HISTORY: "Cancel history",
  REFUSED_HISTORY: "Refused / failed delivery history",
  IP_BURST: "High order rate from IP",
  TRUSTED_DELIVERED: "Trusted delivery history",
  RISKY_THRESHOLD: "Risk score at or above threshold",
};

export type CodRiskHistory = {
  deliveredCount: number;
  cancelledCount: number;
  refusedCount: number;
  openCodPendingCount: number;
};

export type CodRiskInput = {
  phoneNorm: string | null;
  emailNorm: string | null;
  orderTotal: number;
  paymentMethod: string;
  history: CodRiskHistory;
  blacklistHit: boolean;
  ipOrderCount24h: number;
  settings: Pick<
    OrderProtectionSettings,
    | "cod_new_customer_cap"
    | "cod_max_open_per_phone"
    | "cod_risky_mode"
    | "cod_advance_delivery_charge"
    | "cod_risk_threshold"
    | "advance_methods"
    | "cod_otp_enabled"
  >;
  /** True when OTP flag on AND provider configured. */
  otpEffective: boolean;
};

export type CodRiskResult = {
  score: number;
  reasons: RiskReasonCode[];
  codAllowed: boolean;
  allowedMethods: Array<"cod" | AdvanceMethod>;
  otpRequired: boolean;
  advanceDeliveryChargeRequired: boolean;
  advanceDeliveryCharge: number;
};

function clampScore(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function uniqueMethods(methods: Array<"cod" | AdvanceMethod>): Array<"cod" | AdvanceMethod> {
  const out: Array<"cod" | AdvanceMethod> = [];
  for (const m of methods) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * Deterministic risk evaluation. See phase0/DESIGN.md §5.3.
 */
export function evaluateCodRisk(input: CodRiskInput): CodRiskResult {
  const { settings, history } = input;
  const advance = [...settings.advance_methods] as AdvanceMethod[];
  const reasons: RiskReasonCode[] = [];
  let score = 0;

  const isNew = history.deliveredCount === 0;
  if (isNew) {
    score += 25;
    reasons.push("NEW_CUSTOMER");
  }

  const overCap = isNew && input.orderTotal > settings.cod_new_customer_cap;
  if (overCap) {
    score += 40;
    reasons.push("OVER_CAP");
  }

  const openBlocked = history.openCodPendingCount >= settings.cod_max_open_per_phone;
  if (openBlocked) {
    score += 35;
    reasons.push("OPEN_COD");
  }

  const cancelAdd = Math.min(3, Math.max(0, history.cancelledCount)) * 10;
  if (cancelAdd > 0) {
    score += cancelAdd;
    reasons.push("CANCEL_HISTORY");
  }

  const refusedAdd = Math.min(2, Math.max(0, history.refusedCount)) * 15;
  if (refusedAdd > 0) {
    score += refusedAdd;
    reasons.push("REFUSED_HISTORY");
  }

  if (input.ipOrderCount24h >= 5) {
    score += 20;
    reasons.push("IP_BURST");
  }

  if (history.deliveredCount >= 3) {
    score -= 15;
    reasons.push("TRUSTED_DELIVERED");
  }

  score = clampScore(score);

  let codAllowed = true;
  let advanceDeliveryChargeRequired = false;
  const mode: RiskyMode = settings.cod_risky_mode;
  const charge = settings.cod_advance_delivery_charge;

  if (input.blacklistHit) {
    score = 100;
    if (!reasons.includes("BLACKLIST")) reasons.unshift("BLACKLIST");
    codAllowed = false;
  }

  if (openBlocked) {
    codAllowed = false;
  }

  // Over-cap / risky handling
  const risky = score >= settings.cod_risk_threshold;
  if (risky && !reasons.includes("RISKY_THRESHOLD") && !input.blacklistHit) {
    reasons.push("RISKY_THRESHOLD");
  }

  if (overCap || (risky && !input.blacklistHit && !openBlocked)) {
    if (mode === "advance_delivery_charge" && charge > 0) {
      // COD still allowed but requires advance delivery charge fields.
      advanceDeliveryChargeRequired = true;
      codAllowed = true;
    } else {
      codAllowed = false;
      advanceDeliveryChargeRequired = false;
    }
  }

  // Blacklist always wins (D31).
  if (input.blacklistHit) {
    codAllowed = false;
    advanceDeliveryChargeRequired = false;
  }

  // Open COD always blocks COD (even in delivery-charge mode).
  if (openBlocked) {
    codAllowed = false;
    advanceDeliveryChargeRequired = false;
  }

  // Delivery-charge mode unusable when charge is 0 and we'd need it.
  if (
    !input.blacklistHit &&
    !openBlocked &&
    (overCap || risky) &&
    mode === "advance_delivery_charge" &&
    charge <= 0
  ) {
    codAllowed = false;
    advanceDeliveryChargeRequired = false;
  }

  const allowedMethods = uniqueMethods(
    codAllowed ? (["cod", ...advance] as Array<"cod" | AdvanceMethod>) : [...advance]
  );

  const otpRequired = Boolean(codAllowed && input.otpEffective);

  return {
    score,
    reasons,
    codAllowed,
    allowedMethods,
    otpRequired,
    advanceDeliveryChargeRequired,
    advanceDeliveryCharge: advanceDeliveryChargeRequired ? charge : 0,
  };
}

export type HistoryQueryConn = Pool | PoolConnection;

export async function loadCodRiskHistory(
  conn: HistoryQueryConn,
  phoneNorm: string | null
): Promise<CodRiskHistory> {
  if (!phoneNorm) {
    return { deliveredCount: 0, cancelledCount: 0, refusedCount: 0, openCodPendingCount: 0 };
  }
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
         SUM(CASE WHEN status IN ('pending','confirmed','ready_for_pickup') AND payment_method = 'cod' THEN 1 ELSE 0 END) AS open_cod
       FROM orders
       WHERE customer_phone_norm = ?`,
      [phoneNorm]
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const history: CodRiskHistory = {
      deliveredCount: Number(row?.delivered_count || 0),
      cancelledCount: Number(row?.cancelled_count || 0),
      refusedCount: 0, // reserved; no refused status in schema yet
      openCodPendingCount: Number(row?.open_cod || 0),
    };
    // BATCH-12: RTO history. Separate, optional query so a database without migration 0009 behaves
    // exactly as before. Any failure here zeroes ONLY refusedCount (never the counts above).
    history.refusedCount = await loadRefusedCount(conn, phoneNorm);
    return history;
  } catch {
    return { deliveredCount: 0, cancelledCount: 0, refusedCount: 0, openCodPendingCount: 0 };
  }
}

/**
 * Orders returned to origin (orders.rto = 1) for this phone. Runs ONLY when the orders.rto column
 * exists (cached INFORMATION_SCHEMA probe: positive forever, negative re-checked every 30s).
 * Never throws: probe or query failure => 0.
 */
async function loadRefusedCount(conn: HistoryQueryConn, phoneNorm: string): Promise<number> {
  try {
    if (!(await hasRtoColumn(conn))) return 0;
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS refused_count FROM orders
       WHERE customer_phone_norm = ? AND rto = 1`,
      [phoneNorm]
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const n = Number(row?.refused_count || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function loadBlacklistHit(
  conn: HistoryQueryConn,
  phoneNorm: string | null,
  emailNorm: string | null
): Promise<boolean> {
  if (!phoneNorm && !emailNorm) return false;
  try {
    const clauses: string[] = [];
    const params: string[] = [];
    if (phoneNorm) {
      clauses.push("(phone_norm = ?)");
      params.push(phoneNorm);
    }
    if (emailNorm) {
      clauses.push("(email_norm = ?)");
      params.push(emailNorm);
    }
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM customer_blacklist
       WHERE active = 1 AND (${clauses.join(" OR ")})
       LIMIT 1`,
      params
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function loadIpOrderCount24h(
  conn: HistoryQueryConn,
  ipHash: string | null
): Promise<number> {
  if (!ipHash) return 0;
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM otp_challenges
       WHERE ip_hash = ? AND created_at >= (NOW() - INTERVAL 24 HOUR)`,
      [ipHash]
    );
    return Number((Array.isArray(rows) ? rows[0]?.c : 0) || 0);
  } catch {
    return 0;
  }
}
