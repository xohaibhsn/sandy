import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export const CANCEL_REASON_MAX = 500;

/** Stable machine code when production DB lacks cancel_reason. */
export const CANCEL_COLUMN_MISSING = 'CANCEL_COLUMN_MISSING';

export const CANCEL_COLUMN_MISSING_MESSAGE =
  'Cancelling orders needs a one-time database update (cancel_reason column). Ask the owner to apply it.';

/**
 * Preset codes accepted from the client. Labels are the stored strings
 * (except "other", which stores the free-text note).
 */
export const CANCEL_PRESETS = [
  { code: 'customer_cancelled', label: 'Customer cancelled the order' },
  { code: 'wrong_address', label: 'Wrong or unreachable address' },
  { code: 'payment_not_received', label: 'Payment not received' },
  { code: 'duplicate_order', label: 'Duplicate order' },
  { code: 'out_of_stock', label: 'Out of stock' },
  { code: 'other', label: 'Other' },
] as const;

export type CancelPresetCode = (typeof CANCEL_PRESETS)[number]['code'];

const PRESET_BY_CODE = new Map<string, (typeof CANCEL_PRESETS)[number]>(
  CANCEL_PRESETS.map((p) => [p.code, p])
);

export type ComposeCancelReasonResult =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/** Strip C0 controls and DEL; preserve ordinary whitespace for notes. */
export function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) continue;
    out += value[i];
  }
  return out;
}

/**
 * Server-side composition of the stored cancel_reason string.
 * Never trusts a client-supplied final string.
 */
export function composeCancelReason(
  code: unknown,
  note: unknown
): ComposeCancelReasonResult {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'A cancellation reason is required' };
  }
  const preset = PRESET_BY_CODE.get(code.trim());
  if (!preset) {
    return { ok: false, error: 'Invalid cancellation reason' };
  }

  if (preset.code !== 'other') {
    return { ok: true, reason: preset.label };
  }

  if (typeof note !== 'string') {
    return { ok: false, error: 'A note is required for Other' };
  }
  const cleaned = stripControlChars(note).trim();
  if (!cleaned) {
    return { ok: false, error: 'A note is required for Other' };
  }
  if (cleaned.length > CANCEL_REASON_MAX) {
    return {
      ok: false,
      error: `Cancellation note must be at most ${CANCEL_REASON_MAX} characters`,
    };
  }
  return { ok: true, reason: cleaned };
}

type ColumnCache = {
  present: boolean | null;
  lastNegativeAt: number;
};

const columnCache: ColumnCache = {
  present: null,
  lastNegativeAt: 0,
};

/** Test-only: reset module cache between column-absent / column-present runs. */
export function resetCancelReasonColumnCache(): void {
  columnCache.present = null;
  columnCache.lastNegativeAt = 0;
}

type Queryable = Pool | PoolConnection;

/**
 * Read-only column probe. Positive results are cached for the process lifetime.
 * Negative results are re-checked at most every 30 seconds so the feature turns
 * on automatically after the owner applies the ALTER (no redeploy).
 */
export async function hasCancelReasonColumn(db: Queryable): Promise<boolean> {
  if (columnCache.present === true) return true;

  const now = Date.now();
  if (
    columnCache.present === false &&
    now - columnCache.lastNegativeAt < 30_000
  ) {
    return false;
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SHOW COLUMNS FROM orders LIKE 'cancel_reason'"
    );
    const found = Array.isArray(rows) && rows.length > 0;
    if (found) {
      columnCache.present = true;
      return true;
    }
    columnCache.present = false;
    columnCache.lastNegativeAt = now;
    return false;
  } catch {
    columnCache.present = false;
    columnCache.lastNegativeAt = now;
    return false;
  }
}
