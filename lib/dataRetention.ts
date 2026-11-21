/**
 * Best-effort purge of stale checkout / OTP rows (HARDEN-01).
 * No DDL. Uses the DB clock. Never throws to callers.
 */
import type { Pool, ResultSetHeader } from "mysql2/promise";
import { recordAudit } from "./auditLog";

/** PROPOSED D58, owner may change */
export const RETENTION_DAYS = 30;

const THROTTLE_MS = 6 * 60 * 60 * 1000;
const DELETE_LIMIT = 500;

let lastPurgeAt = 0;

type Queryable = Pick<Pool, "query">;

function affected(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const n = (result as ResultSetHeader).affectedRows;
  return typeof n === "number" && n > 0 ? n : 0;
}

/**
 * At most once per 6 hours per process. Bounded DELETE … LIMIT 500 per table.
 * Writes one data_purge audit row only when something was deleted.
 */
export async function maybePurgeStaleRows(
  pool: Queryable,
  now: number = Date.now()
): Promise<void> {
  try {
    if (now - lastPurgeAt < THROTTLE_MS) return;
    lastPurgeAt = now;

    let checkoutAttempts = 0;
    let otpChallenges = 0;

    try {
      const [r] = await pool.query(
        `DELETE FROM order_checkout_attempts WHERE created_at < NOW() - INTERVAL ${RETENTION_DAYS} DAY LIMIT ${DELETE_LIMIT}`
      );
      checkoutAttempts = affected(r);
    } catch {
      /* best-effort */
    }

    try {
      const [r] = await pool.query(
        `DELETE FROM otp_challenges WHERE created_at < NOW() - INTERVAL ${RETENTION_DAYS} DAY LIMIT ${DELETE_LIMIT}`
      );
      otpChallenges = affected(r);
    } catch {
      /* best-effort */
    }

    if (checkoutAttempts > 0 || otpChallenges > 0) {
      await recordAudit(pool as Pool, {
        actor: { actorType: "system", name: "system" },
        action: "data_purge",
        entityType: "retention",
        entityId: null,
        summary: "Stale retention purge",
        detail: {
          checkout_attempts: checkoutAttempts,
          otp_challenges: otpChallenges,
        },
      });
    }
  } catch {
    /* never throw to callers */
  }
}

/** Test-only: reset in-memory throttle. */
export function resetDataRetentionThrottleForTests(): void {
  lastPurgeAt = 0;
}

/** Test-only: inspect last purge timestamp. */
export function getDataRetentionLastPurgeForTests(): number {
  return lastPurgeAt;
}
