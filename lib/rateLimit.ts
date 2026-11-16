// Simple in-memory rate limiter for Next.js API routes
import { isIP } from "node:net";

const STORE_CAP = 20_000;
const STORE_EVICT_FLOOR = Math.floor(STORE_CAP * 0.9);
const MAX_XFF_LENGTH = 512;

type RateRecord = { count: number; resetAt: number };

const store = new Map<string, RateRecord>();

type HeaderValue = string | string[] | undefined;

type IpRequest = {
  headers: { [key: string]: HeaderValue };
  socket?: { remoteAddress?: string };
};

// Clean old entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}, 5 * 60 * 1000);

if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

function purgeExpired(now: number): void {
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}

function evictOldestToFloor(): void {
  if (store.size < STORE_CAP) return;
  for (const key of store.keys()) {
    if (store.size <= STORE_EVICT_FLOOR) break;
    store.delete(key);
  }
}

function ensureStoreCapacity(now: number): void {
  if (store.size < STORE_CAP) return;
  purgeExpired(now);
  if (store.size >= STORE_CAP) {
    evictOldestToFloor();
  }
}

/**
 * Normalize a single hop candidate for net.isIP.
 * Strips brackets, ports, and IPv4-mapped IPv6 prefix. Never throws.
 */
function normalizeIpCandidate(raw: string): string {
  let s = raw.trim();
  if (!s) return "";

  // Strip optional surrounding quotes
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }

  // Bracketed IPv6: [addr] or [addr]:port
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 1) {
      s = s.slice(1, end);
    }
  } else {
    // IPv4 with port: a.b.c.d:port (exactly one colon, dotted quad before it)
    const colon = s.lastIndexOf(":");
    if (colon > 0 && s.indexOf(":") === colon) {
      const maybeV4 = s.slice(0, colon);
      if (isIP(maybeV4) === 4) {
        s = maybeV4;
      }
    }
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) {
    s = mapped[1];
  }

  return s;
}

function validatedIp(raw: string): string | null {
  const normalized = normalizeIpCandidate(raw);
  if (!normalized) return null;
  return isIP(normalized) !== 0 ? normalized : null;
}

function headerToString(value: HeaderValue): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Client IP for rate limiting: rightmost valid hop in X-Forwarded-For
 * (platform-appended), else socket.remoteAddress, else "unknown".
 * Does not trust X-Real-IP / CF-Connecting-IP / True-Client-IP.
 * Never throws.
 */
export function getClientIp(req: IpRequest): string {
  try {
    const rawXff = headerToString(req.headers["x-forwarded-for"]);
    if (rawXff && rawXff.length <= MAX_XFF_LENGTH) {
      const hops = rawXff.split(",");
      for (let i = hops.length - 1; i >= 0; i--) {
        const ip = validatedIp(hops[i]);
        if (ip) return ip;
      }
    }

    const remote = req.socket?.remoteAddress;
    if (typeof remote === "string" && remote) {
      const ip = validatedIp(remote);
      if (ip) return ip;
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function rateLimit(
  ip: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const key = ip;
  const record = store.get(key);

  if (!record || now > record.resetAt) {
    ensureStoreCapacity(now);
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (record.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: limit - record.count };
}

// Presets
export const RL_GENERAL = (ip: string) =>
  rateLimit(`general:${ip}`, 100, 15 * 60 * 1000);
export const RL_AUTH = (ip: string) =>
  rateLimit(`auth:${ip}`, 5, 15 * 60 * 1000);
export const RL_SEARCH = (ip: string) =>
  rateLimit(`search:${ip}`, 60, 60 * 1000);

/** @internal test helpers — not part of public API contract */
export const __rateLimitTestUtils = {
  STORE_CAP,
  STORE_EVICT_FLOOR,
  MAX_XFF_LENGTH,
  getStoreSize: () => store.size,
  clearStore: () => store.clear(),
  seedExpired: (key: string) => {
    store.set(key, { count: 1, resetAt: Date.now() - 1 });
  },
  normalizeIpCandidate,
};
