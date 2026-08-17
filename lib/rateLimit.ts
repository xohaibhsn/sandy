// Simple in-memory rate limiter for Next.js API routes
const store = new Map<string, { count: number; resetAt: number }>();

// Clean old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.resetAt) store.delete(key);
  }
}, 5 * 60 * 1000);

export function rateLimit(ip: string, limit: number, windowMs: number): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const key = ip;
  const record = store.get(key);

  if (!record || now > record.resetAt) {
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
export const RL_GENERAL = (ip: string) => rateLimit(`general:${ip}`, 100, 15 * 60 * 1000);
export const RL_AUTH    = (ip: string) => rateLimit(`auth:${ip}`, 5, 15 * 60 * 1000);
export const RL_SEARCH  = (ip: string) => rateLimit(`search:${ip}`, 60, 60 * 1000);

export function getClientIp(req: { headers: any; socket?: any }): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : String(forwarded || "").split(",")[0]?.trim();
  return (
    forwardedIp ||
    req.headers["x-real-ip"] ||
    req.headers["cf-connecting-ip"] ||
    req.headers["true-client-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}
