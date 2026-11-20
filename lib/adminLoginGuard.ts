/**
 * Per-account admin login lockout (ADMIN-LOGIN-01).
 * In-memory Map only: capped keys, oldest-insertion eviction, no timers, no I/O.
 *
 * Key A = normalizedUsername + ":" + ipHash — 5 failed passwords / 15 min → locked 15 min.
 * Key B = normalizedUsername — 20 failed passwords / 15 min → locked 15 min
 *   (distributed guessing protection; documented DoS trade-off: many attackers can lock a username).
 *
 * Checked BEFORE credential verification. Only real wrong-password outcomes increment.
 */
import crypto from "crypto";
import { hashAuditIp } from "./auditLog";

export const ADMIN_LOGIN_GUARD_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_LOGIN_GUARD_LOCK_MS = 15 * 60 * 1000;
export const ADMIN_LOGIN_GUARD_KEY_A_MAX_FAILURES = 5;
export const ADMIN_LOGIN_GUARD_KEY_B_MAX_FAILURES = 20;
export const ADMIN_LOGIN_GUARD_CAP = 5000;

/** Same body text as RL_AUTH 429 — no user enumeration. */
export const ADMIN_LOGIN_LOCK_BODY = {
  error: "Too many login attempts. Try again in 15 minutes.",
} as const;

type GuardEntry = {
  failures: number[];
  lockedUntil: number;
};

const store = new Map<string, GuardEntry>();

/** Test-only clock override; null = use Date.now() / caller `now`. */
let clockOverride: number | null = null;

export function setAdminLoginGuardClockForTests(now: number | null): void {
  clockOverride = now;
}

function resolveNow(now?: number): number {
  if (typeof now === "number") return now;
  if (clockOverride != null) return clockOverride;
  return Date.now();
}

export function normalizeLoginUsername(username: unknown): string {
  return String(username ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

function keyA(normUser: string, ipHash: string): string {
  return `a:${normUser}:${ipHash}`;
}

function keyB(normUser: string): string {
  return `b:${normUser}`;
}

function ensureCap(): void {
  while (store.size >= ADMIN_LOGIN_GUARD_CAP) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function getOrCreate(key: string): GuardEntry {
  const existing = store.get(key);
  if (existing) {
    // Refresh insertion order on touch so active keys are not evicted first.
    store.delete(key);
    store.set(key, existing);
    return existing;
  }
  ensureCap();
  const created: GuardEntry = { failures: [], lockedUntil: 0 };
  store.set(key, created);
  return created;
}

function pruneFailures(entry: GuardEntry, now: number): void {
  const cutoff = now - ADMIN_LOGIN_GUARD_WINDOW_MS;
  entry.failures = entry.failures.filter((t) => t > cutoff);
}

/**
 * Timing-safe compare of two SHA-256 hex digests (or any equal-length utf8 strings of digests).
 * Different lengths → false (never throws). Used for master SHA-256 and plaintext paths.
 */
export function timingSafeEqualDigest(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(String(a), "utf8");
    const bBuf = Buffer.from(String(b), "utf8");
    if (aBuf.length !== bBuf.length) return false;
    if (aBuf.length === 0) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Hash both sides to SHA-256 hex, then timing-safe compare.
 * Used for master plaintext ADMIN_PASSWORD path (never compare raw strings with ===).
 */
export function timingSafeEqualSha256OfStrings(left: string, right: string): boolean {
  const leftHash = crypto.createHash("sha256").update(String(left), "utf8").digest("hex");
  const rightHash = crypto.createHash("sha256").update(String(right), "utf8").digest("hex");
  return timingSafeEqualDigest(leftHash, rightHash);
}

export function checkAdminLoginGuard(params: {
  username: unknown;
  clientIp: string;
  now?: number;
}): { locked: boolean; normUser: string; ipHash: string } {
  const now = resolveNow(params.now);
  const normUser = normalizeLoginUsername(params.username);
  const ipHash = hashAuditIp(params.clientIp);
  if (!normUser) {
    return { locked: false, normUser, ipHash };
  }

  const a = store.get(keyA(normUser, ipHash));
  const b = store.get(keyB(normUser));
  const lockedA = a != null && a.lockedUntil > now;
  const lockedB = b != null && b.lockedUntil > now;
  return { locked: lockedA || lockedB, normUser, ipHash };
}

export function recordAdminLoginFailure(params: {
  username: unknown;
  clientIp: string;
  now?: number;
}): void {
  const now = resolveNow(params.now);
  const normUser = normalizeLoginUsername(params.username);
  if (!normUser) return;
  const ipHash = hashAuditIp(params.clientIp);

  const aKey = keyA(normUser, ipHash);
  const bKey = keyB(normUser);
  const a = getOrCreate(aKey);
  const b = getOrCreate(bKey);

  pruneFailures(a, now);
  pruneFailures(b, now);
  a.failures.push(now);
  b.failures.push(now);

  if (a.failures.length >= ADMIN_LOGIN_GUARD_KEY_A_MAX_FAILURES) {
    a.lockedUntil = Math.max(a.lockedUntil, now + ADMIN_LOGIN_GUARD_LOCK_MS);
  }
  if (b.failures.length >= ADMIN_LOGIN_GUARD_KEY_B_MAX_FAILURES) {
    b.lockedUntil = Math.max(b.lockedUntil, now + ADMIN_LOGIN_GUARD_LOCK_MS);
  }
}

/** Successful login clears key A and key B for that username (all IP variants of A for this IP). */
export function clearAdminLoginGuard(params: {
  username: unknown;
  clientIp: string;
}): void {
  const normUser = normalizeLoginUsername(params.username);
  if (!normUser) return;
  const ipHash = hashAuditIp(params.clientIp);
  store.delete(keyA(normUser, ipHash));
  store.delete(keyB(normUser));
}

export function resetAdminLoginGuardForTests(): void {
  store.clear();
  clockOverride = null;
}

/** Test-only: current map size (cap eviction). */
export function getAdminLoginGuardSizeForTests(): number {
  return store.size;
}

/** Test-only: inspect an entry. */
export function getAdminLoginGuardEntryForTests(
  kind: "a" | "b",
  username: string,
  clientIp?: string
): GuardEntry | undefined {
  const norm = normalizeLoginUsername(username);
  if (kind === "b") return store.get(keyB(norm));
  if (!clientIp) return undefined;
  return store.get(keyA(norm, hashAuditIp(clientIp)));
}
