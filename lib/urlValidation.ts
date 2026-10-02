/**
 * Pure URL / path validation primitives for server write authority.
 * No DB, network, env, filesystem, or side effects.
 */

export const MAX_URL_REFERENCE_LENGTH = 2048;

const DANGEROUS_SCHEME =
  /^(?:javascript|vbscript|data|file|ftp|blob|filesystem|about)\s*:/i;

const CONTROL_OR_BACKSLASH = /[\u0000-\u001F\u007F\\]/;

export class UrlValidationError extends Error {
  constructor(message = "Invalid URL or path") {
    super(message);
    this.name = "UrlValidationError";
  }
}

export type HttpUrlOptions = {
  allowHttp?: boolean;
  allowEmpty?: boolean;
};

function fail(message = "Invalid URL or path"): never {
  throw new UrlValidationError(message);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") fail("Invalid URL or path");
  return value;
}

function trimBounded(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_REFERENCE_LENGTH) fail("Invalid URL or path");
  return trimmed;
}

function hasControlOrBackslash(value: string): boolean {
  return CONTROL_OR_BACKSLASH.test(value);
}

function looksDangerousScheme(value: string): boolean {
  return DANGEROUS_SCHEME.test(value);
}

function isProtocolRelative(value: string): boolean {
  return value.startsWith("//");
}

function splitPathQueryHash(value: string): {
  path: string;
  search: string;
  hash: string;
} {
  const hashIdx = value.indexOf("#");
  const withoutHash = hashIdx >= 0 ? value.slice(0, hashIdx) : value;
  const hash = hashIdx >= 0 ? value.slice(hashIdx) : "";
  const qIdx = withoutHash.indexOf("?");
  const path = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const search = qIdx >= 0 ? withoutHash.slice(qIdx) : "";
  return { path, search, hash };
}

function pathHasTraversal(path: string): boolean {
  // Check raw and decoded forms so URL normalization cannot hide ../.
  const candidates = [path];
  try {
    candidates.push(decodeURIComponent(path));
  } catch {
    return true;
  }
  for (const candidate of candidates) {
    if (hasControlOrBackslash(candidate)) return true;
    const segments = candidate.split("/");
    for (const seg of segments) {
      if (seg === ".." || seg === ".") return true;
      // Encoded dots that survive as literal segment text
      const lower = seg.toLowerCase();
      if (lower === "%2e%2e" || lower === "%2e" || lower === "..%00") return true;
    }
  }
  return false;
}

function parseAbsoluteHttpUrl(value: string, allowHttp: boolean): URL {
  if (looksDangerousScheme(value) || isProtocolRelative(value)) {
    fail("Invalid URL or path");
  }
  if (hasControlOrBackslash(value)) fail("Invalid URL or path");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("Invalid URL or path");
  }

  if (parsed.protocol === "https:") {
    /* ok */
  } else if (allowHttp && parsed.protocol === "http:") {
    /* ok */
  } else {
    fail("Invalid URL or path");
  }

  if (parsed.username || parsed.password) fail("Invalid URL or path");
  if (hasControlOrBackslash(parsed.href)) fail("Invalid URL or path");
  return parsed;
}

function normalizeWwwHost(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function pathSegmentsContainSandyReceipts(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const segments = decoded.split("/").filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "sandy" && segments[i + 1] === "receipts") {
      return true;
    }
  }
  return false;
}

/**
 * CMS navigation paths: root-relative internal links only.
 * Optionally prefixes a missing leading slash after rejecting schemes.
 */
export function assertSafeInternalPath(value: unknown): string {
  const raw = requireString(value);
  let trimmed = trimBounded(raw);
  if (!trimmed) fail("Invalid URL or path");
  if (hasControlOrBackslash(trimmed)) fail("Invalid URL or path");
  if (looksDangerousScheme(trimmed)) fail("Invalid URL or path");
  if (isProtocolRelative(trimmed)) fail("Invalid URL or path");

  // Reject scheme-like inputs before slash normalization.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) fail("Invalid URL or path");

  if (!trimmed.startsWith("/")) {
    trimmed = `/${trimmed}`;
  }

  if (isProtocolRelative(trimmed)) fail("Invalid URL or path");
  if (hasControlOrBackslash(trimmed)) fail("Invalid URL or path");

  const { path, search, hash } = splitPathQueryHash(trimmed);
  if (!path.startsWith("/") || isProtocolRelative(path)) fail("Invalid URL or path");
  if (pathHasTraversal(path)) fail("Invalid URL or path");
  if (hasControlOrBackslash(search) || hasControlOrBackslash(hash)) {
    fail("Invalid URL or path");
  }

  // Validate via URL parser without trusting its traversal normalization.
  try {
    const parsed = new URL(trimmed, "https://validation.invalid");
    if (parsed.origin !== "https://validation.invalid") fail("Invalid URL or path");
  } catch {
    fail("Invalid URL or path");
  }

  return `${path}${search}${hash}`;
}

/**
 * Absolute http(s) URLs for social / external links.
 * Default: HTTPS only. Set allowHttp for legacy http.
 */
export function assertSafeHttpUrl(
  value: unknown,
  options: HttpUrlOptions = {}
): string {
  const allowHttp = options.allowHttp === true;
  const allowEmpty = options.allowEmpty === true;
  const raw = requireString(value);
  const trimmed = trimBounded(raw);
  if (!trimmed) {
    if (allowEmpty) return "";
    fail("Invalid URL or path");
  }

  const parsed = parseAbsoluteHttpUrl(trimmed, allowHttp);
  return parsed.toString();
}

/**
 * Image references: empty, root-relative path, or https absolute URL.
 * Fragments rejected for image refs. Query allowed for transforms/cache-bust.
 */
export function assertSafeImageUrl(value: unknown): string {
  const raw = requireString(value);
  const trimmed = trimBounded(raw);
  if (!trimmed) return "";

  if (hasControlOrBackslash(trimmed)) fail("Invalid URL or path");
  if (looksDangerousScheme(trimmed)) fail("Invalid URL or path");
  if (isProtocolRelative(trimmed)) fail("Invalid URL or path");

  if (trimmed.startsWith("/")) {
    const { path, search, hash } = splitPathQueryHash(trimmed);
    if (hash) fail("Invalid URL or path");
    if (!path.startsWith("/") || isProtocolRelative(path)) fail("Invalid URL or path");
    if (pathHasTraversal(path)) fail("Invalid URL or path");
    if (hasControlOrBackslash(search)) fail("Invalid URL or path");
    try {
      const parsed = new URL(trimmed, "https://validation.invalid");
      if (parsed.origin !== "https://validation.invalid") fail("Invalid URL or path");
    } catch {
      fail("Invalid URL or path");
    }
    return `${path}${search}`;
  }

  // Absolute: HTTPS only (no http for images).
  const parsed = parseAbsoluteHttpUrl(trimmed, false);
  if (parsed.hash) fail("Invalid URL or path");
  if (pathHasTraversal(parsed.pathname || "/")) fail("Invalid URL or path");
  return parsed.toString();
}

/**
 * Blog/product canonical metadata URLs.
 * Empty allowed (caller supplies default). Absolute HTTPS same-site only.
 * siteOrigin must be provided by the caller (e.g. SITE_URL) — never hardcoded.
 */
export function assertSafeCanonicalUrl(
  value: unknown,
  siteOrigin: unknown
): string {
  const originRaw = requireString(siteOrigin);
  const originTrimmed = trimBounded(originRaw);
  if (!originTrimmed) fail("Invalid URL or path");

  let siteUrl: URL;
  try {
    siteUrl = new URL(originTrimmed);
  } catch {
    fail("Invalid URL or path");
  }
  if (siteUrl.protocol !== "https:") fail("Invalid URL or path");
  if (siteUrl.username || siteUrl.password) fail("Invalid URL or path");

  const raw = requireString(value);
  const trimmed = trimBounded(raw);
  if (!trimmed) return "";

  if (hasControlOrBackslash(trimmed)) fail("Invalid URL or path");
  if (looksDangerousScheme(trimmed)) fail("Invalid URL or path");
  if (isProtocolRelative(trimmed)) fail("Invalid URL or path");
  if (trimmed.startsWith("/")) fail("Invalid URL or path");

  const parsed = parseAbsoluteHttpUrl(trimmed, false);
  if (parsed.hash) fail("Invalid URL or path");

  const inputHost = normalizeWwwHost(parsed.hostname);
  const siteHost = normalizeWwwHost(siteUrl.hostname);
  if (!inputHost || inputHost !== siteHost) fail("Invalid URL or path");

  // Prefer configured site origin (no www spoof retained).
  const normalized = new URL(parsed.pathname + parsed.search, siteUrl.origin);
  return normalized.toString();
}

/**
 * Order receipt references: empty, Cloudinary HTTPS under sandy/receipts,
 * or local /uploads/receipts/... only.
 */
export function assertSafeReceiptUrl(value: unknown): string {
  const raw = requireString(value);
  const trimmed = trimBounded(raw);
  if (!trimmed) return "";

  if (hasControlOrBackslash(trimmed)) fail("Invalid URL or path");
  if (looksDangerousScheme(trimmed)) fail("Invalid URL or path");
  if (isProtocolRelative(trimmed)) fail("Invalid URL or path");

  if (trimmed.startsWith("/")) {
    const { path, search, hash } = splitPathQueryHash(trimmed);
    if (hash) fail("Invalid URL or path");
    if (!path.startsWith("/") || isProtocolRelative(path)) fail("Invalid URL or path");
    if (pathHasTraversal(path)) fail("Invalid URL or path");
    if (hasControlOrBackslash(search)) fail("Invalid URL or path");

    const segments = (() => {
      try {
        return decodeURIComponent(path).split("/").filter(Boolean);
      } catch {
        fail("Invalid URL or path");
      }
    })();
    if (segments.length < 3) fail("Invalid URL or path");
    if (segments[0] !== "uploads" || segments[1] !== "receipts") {
      fail("Invalid URL or path");
    }
    return `${path}${search}`;
  }

  const parsed = parseAbsoluteHttpUrl(trimmed, false);
  if (parsed.hostname.toLowerCase() !== "res.cloudinary.com") {
    fail("Invalid URL or path");
  }
  if (parsed.hash) fail("Invalid URL or path");
  if (!pathSegmentsContainSandyReceipts(parsed.pathname || "/")) {
    fail("Invalid URL or path");
  }
  if (pathHasTraversal(parsed.pathname || "/")) fail("Invalid URL or path");
  return parsed.toString();
}
