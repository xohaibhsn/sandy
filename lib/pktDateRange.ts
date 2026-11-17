/**
 * Asia/Karachi calendar-day helpers for admin date filters.
 * DB stores UTC; Karachi is fixed UTC+5 (no DST).
 */

export type PktYmd = { y: number; m: number; day: number };
export type PktPreset = "today" | "7d" | "30d" | "this_month" | "all" | "custom";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PKT_MAX_RANGE_DAYS = 400;

export function karachiParts(d = new Date()): PktYmd {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/** Karachi calendar midnight as a MySQL-friendly UTC DATETIME string. */
export function karachiMidnightUtcSql(y: number, m: number, day: number): string {
  const utcMs = Date.UTC(y, m - 1, day, 0, 0, 0) - 5 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

export function addDays(y: number, m: number, day: number, delta: number): PktYmd {
  const dt = new Date(Date.UTC(y, m - 1, day + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function daysBetween(a: PktYmd, b: PktYmd): number {
  const aMs = Date.UTC(a.y, a.m - 1, a.day);
  const bMs = Date.UTC(b.y, b.m - 1, b.day);
  return Math.round((bMs - aMs) / 86400000);
}

export function parseIsoDate(v: unknown): PktYmd | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  const [ys, ms, ds] = v.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const day = Number(ds);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(day)) return null;
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== day) {
    return null;
  }
  return { y, m, day };
}

export function ymdToString(p: PktYmd): string {
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Format a UTC Date / SQL datetime as Asia/Karachi wall time string. */
export function formatPktDateTime(value: unknown): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function pktTodayYmdString(d = new Date()): string {
  return ymdToString(karachiParts(d));
}

export type ResolvedPktRange =
  | {
      ok: true;
      preset: PktPreset;
      fromSql: string | null;
      toExclusiveSql: string | null;
      from: string | null;
      to: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * Resolve preset / custom from+to (YYYY-MM-DD) into UTC SQL half-open bounds.
 * Custom: inclusive calendar days in Asia/Karachi → [fromSql, toExclusiveSql).
 */
export function resolvePktRange(input: {
  preset?: unknown;
  from?: unknown;
  to?: unknown;
  defaultPreset?: PktPreset;
}): ResolvedPktRange {
  const rawPreset = String(input.preset ?? input.defaultPreset ?? "all")
    .trim()
    .toLowerCase();
  const allowed: PktPreset[] = ["today", "7d", "30d", "this_month", "all", "custom"];
  if (!(allowed as string[]).includes(rawPreset)) {
    return { ok: false, status: 400, error: "Invalid date range" };
  }
  const preset = rawPreset as PktPreset;
  const today = karachiParts();

  if (preset === "all") {
    return { ok: true, preset, fromSql: null, toExclusiveSql: null, from: null, to: null };
  }

  let start = today;
  let endExclusive = addDays(today.y, today.m, today.day, 1);

  if (preset === "today") {
    start = today;
  } else if (preset === "7d") {
    start = addDays(today.y, today.m, today.day, -6);
  } else if (preset === "30d") {
    start = addDays(today.y, today.m, today.day, -29);
  } else if (preset === "this_month") {
    start = { y: today.y, m: today.m, day: 1 };
  } else if (preset === "custom") {
    const from = parseIsoDate(input.from);
    const to = parseIsoDate(input.to);
    if (!from || !to) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    if (daysBetween(from, to) < 0) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    if (daysBetween(from, to) > PKT_MAX_RANGE_DAYS) {
      return { ok: false, status: 400, error: "Invalid date range" };
    }
    start = from;
    endExclusive = addDays(to.y, to.m, to.day, 1);
  }

  const fromStr = ymdToString(start);
  const toInclusive = addDays(endExclusive.y, endExclusive.m, endExclusive.day, -1);
  const toStr = ymdToString(toInclusive);

  return {
    ok: true,
    preset,
    fromSql: karachiMidnightUtcSql(start.y, start.m, start.day),
    toExclusiveSql: karachiMidnightUtcSql(endExclusive.y, endExclusive.m, endExclusive.day),
    from: fromStr,
    to: toStr,
  };
}
