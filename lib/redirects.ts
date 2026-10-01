import pool from "./db";

export type RedirectStatusCode = 301 | 302 | 307 | 308;

export interface RedirectRecord {
  id: number;
  source_path: string;
  destination: string;
  status_code: RedirectStatusCode;
  is_active: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export class RedirectValidationError extends Error {
  readonly code = "VALIDATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "RedirectValidationError";
  }
}

export class RedirectConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(message = "Conflict") {
    super(message);
    this.name = "RedirectConflictError";
  }
}

export class RedirectNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(message = "Not found") {
    super(message);
    this.name = "RedirectNotFoundError";
  }
}

const SOURCE_MAX = 500;
const DESTINATION_MAX = 2000;
const LOOP_MAX_DEPTH = 5;

const PROTECTED_PREFIXES = ["/api", "/sidhu", "/_next", "/admin"] as const;

const PROTECTED_EXACT = new Set([
  "/",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/products",
  "/blog",
  "/cart",
  "/cart/success",
  "/contact",
  "/about",
  "/faq",
  "/order-tracking",
  "/privacy-policy",
  "/terms",
  "/refund-policy",
]);

const ALLOWED_STATUS = new Set<number>([301, 302, 307, 308]);

let redirectsReady = false;
let redirectsInFlight: Promise<void> | null = null;
/** In-process negative backoff when redirects table is missing (public lookup only). */
let redirectsMissingUntil = 0;
const REDIRECTS_MISSING_BACKOFF_MS = 60_000;

function hasControlOrCrLf(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function safeDecodePathOnce(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RedirectValidationError("Invalid source path encoding");
  }
}

/**
 * Normalize a redirect source to a local path.
 * Throws RedirectValidationError on invalid input.
 */
export function normalizeRedirectSource(input: unknown): string {
  if (typeof input !== "string") {
    throw new RedirectValidationError("Source path is required");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new RedirectValidationError("Source path is required");
  }
  if (hasControlOrCrLf(trimmed)) {
    throw new RedirectValidationError("Source path contains invalid characters");
  }
  if (trimmed.includes("\\")) {
    throw new RedirectValidationError("Source path must not contain backslashes");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new RedirectValidationError("Source path must be a local path, not a URL");
  }
  if (trimmed.startsWith("//")) {
    throw new RedirectValidationError("Source path must not be protocol-relative");
  }

  let pathOnly = trimmed.split(/[?#]/, 1)[0] || "";
  pathOnly = pathOnly.trim();
  if (!pathOnly) {
    throw new RedirectValidationError("Source path is required");
  }

  pathOnly = safeDecodePathOnce(pathOnly);

  if (hasControlOrCrLf(pathOnly) || pathOnly.includes("\\")) {
    throw new RedirectValidationError("Source path contains invalid characters");
  }
  if (pathOnly.includes("?") || pathOnly.includes("#")) {
    throw new RedirectValidationError("Source path must not contain query or fragment");
  }

  if (!pathOnly.startsWith("/")) {
    pathOnly = `/${pathOnly}`;
  }

  // Collapse duplicate slashes
  pathOnly = pathOnly.replace(/\/{2,}/g, "/");

  // Strip trailing slash except root
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) {
    pathOnly = pathOnly.replace(/\/+$/, "");
  }

  pathOnly = pathOnly.toLowerCase();

  if (!pathOnly || pathOnly.length > SOURCE_MAX) {
    throw new RedirectValidationError("Source path exceeds maximum length");
  }

  return pathOnly;
}

export function isProtectedRedirectSource(path: string): boolean {
  const normalized = path.toLowerCase();
  if (PROTECTED_EXACT.has(normalized)) return true;
  for (const prefix of PROTECTED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function isRedirectStatusCode(value: unknown): value is RedirectStatusCode {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && ALLOWED_STATUS.has(n);
}

export function normalizeRedirectStatus(input: unknown, { required = false } = {}): RedirectStatusCode {
  if (input === undefined || input === null || input === "") {
    if (required) {
      throw new RedirectValidationError("Status code is required");
    }
    return 301;
  }
  const n = typeof input === "string" ? Number(input.trim()) : input;
  if (!isRedirectStatusCode(n)) {
    throw new RedirectValidationError("Invalid redirect status code");
  }
  return n;
}

/**
 * Accept only boolean or numeric 1/0. Reject string "false"/"true" truthiness traps.
 */
export function normalizeIsActive(input: unknown, defaultValue = true): 0 | 1 {
  if (input === undefined || input === null || input === "") {
    return defaultValue ? 1 : 0;
  }
  if (input === true || input === 1) return 1;
  if (input === false || input === 0) return 0;
  throw new RedirectValidationError("Invalid is_active value");
}

/**
 * Validate destination: internal local path OR absolute http(s) URL.
 * Returns trimmed destination exactly as configured (query/fragment preserved for internal).
 */
export function validateRedirectDestination(input: unknown): string {
  if (typeof input !== "string") {
    throw new RedirectValidationError("Destination is required");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new RedirectValidationError("Destination is required");
  }
  if (trimmed.length > DESTINATION_MAX) {
    throw new RedirectValidationError("Destination exceeds maximum length");
  }
  if (hasControlOrCrLf(trimmed)) {
    throw new RedirectValidationError("Destination contains invalid characters");
  }
  if (trimmed.includes("\\")) {
    throw new RedirectValidationError("Destination must not contain backslashes");
  }

  // Protocol-relative
  if (trimmed.startsWith("//")) {
    throw new RedirectValidationError("Protocol-relative destinations are not allowed");
  }

  // Absolute URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new RedirectValidationError("Invalid destination URL");
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      throw new RedirectValidationError("Only http and https destinations are allowed");
    }
    if (parsed.username || parsed.password) {
      throw new RedirectValidationError("Destination URL must not contain credentials");
    }
    return trimmed;
  }

  // Internal path
  if (!trimmed.startsWith("/")) {
    throw new RedirectValidationError("Internal destination must start with /");
  }
  if (trimmed.startsWith("//")) {
    throw new RedirectValidationError("Protocol-relative destinations are not allowed");
  }

  return trimmed;
}

export function isExternalDestination(destination: string): boolean {
  return /^https?:\/\//i.test(destination.trim());
}

/**
 * Extract normalized pathname from an INTERNAL destination for loop checks.
 */
export function extractInternalDestinationPath(destination: string): string | null {
  const dest = destination.trim();
  if (isExternalDestination(dest)) return null;
  if (!dest.startsWith("/") || dest.startsWith("//")) {
    throw new RedirectValidationError("Invalid internal destination");
  }
  return normalizeRedirectSource(dest.split(/[?#]/, 1)[0] || dest);
}

export async function ensureRedirectsTable(): Promise<void> {
  if (redirectsReady) return;
  if (!redirectsInFlight) {
    redirectsInFlight = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS redirects (
          id INT AUTO_INCREMENT PRIMARY KEY,
          source_path VARCHAR(500) NOT NULL,
          destination VARCHAR(2000) NOT NULL,
          status_code SMALLINT NOT NULL DEFAULT 301,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_redirects_source_path (source_path),
          KEY idx_redirect_active_source (is_active, source_path)
        )
      `);
      redirectsReady = true;
      redirectsMissingUntil = 0;
    })().catch((err) => {
      redirectsInFlight = null;
      redirectsReady = false;
      throw err;
    });
  }
  await redirectsInFlight;
}

function mapRow(row: Record<string, unknown>): RedirectRecord {
  return {
    id: Number(row.id),
    source_path: String(row.source_path),
    destination: String(row.destination),
    status_code: Number(row.status_code) as RedirectStatusCode,
    is_active: Number(row.is_active) === 1,
    created_at: row.created_at as string | Date | undefined,
    updated_at: row.updated_at as string | Date | undefined,
  };
}

/**
 * Read-only public/runtime lookup. Does NOT ensure/create the table.
 * ER_NO_SUCH_TABLE uses a short in-process null backoff (not a redirect cache).
 * Other DB errors propagate; Proxy fail-opens with NextResponse.next().
 * Admin CRUD continues to call ensureRedirectsTable() separately.
 */
export async function getActiveRedirectBySource(
  sourcePath: string
): Promise<RedirectRecord | null> {
  const source = normalizeRedirectSource(sourcePath);

  if (Date.now() < redirectsMissingUntil) {
    return null;
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, source_path, destination, status_code, is_active, created_at, updated_at
       FROM redirects
       WHERE source_path = ? AND is_active = 1
       LIMIT 1`,
      [source]
    );
    redirectsMissingUntil = 0;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    return mapRow(list[0] as Record<string, unknown>);
  } catch (err) {
    if (isMysqlNoSuchTable(err)) {
      redirectsMissingUntil = Date.now() + REDIRECTS_MISSING_BACKOFF_MS;
      return null;
    }
    throw err;
  }
}

export async function getRedirectById(id: number): Promise<RedirectRecord | null> {
  await ensureRedirectsTable();
  const [rows] = await pool.query(
    `SELECT id, source_path, destination, status_code, is_active, created_at, updated_at
     FROM redirects WHERE id = ? LIMIT 1`,
    [id]
  );
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  return mapRow(list[0] as Record<string, unknown>);
}

export async function listRedirects(): Promise<RedirectRecord[]> {
  await ensureRedirectsTable();
  const [rows] = await pool.query(
    `SELECT id, source_path, destination, status_code, is_active, created_at, updated_at
     FROM redirects
     ORDER BY updated_at DESC, id DESC`
  );
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * Bounded save-time loop protection over ACTIVE redirects.
 * excludeId: during UPDATE, the existing row being replaced is excluded from
 * traversal of the old graph (treated as removed), so its old source mapping
 * is not followed.
 */
export async function assertNoRedirectLoop(params: {
  sourcePath: string;
  destination: string;
  excludeId?: number | null;
}): Promise<void> {
  await ensureRedirectsTable();

  const source = normalizeRedirectSource(params.sourcePath);
  const destination = validateRedirectDestination(params.destination);
  const nextPath = extractInternalDestinationPath(destination);

  if (nextPath === null) {
    // External destination cannot form an internal loop.
    return;
  }

  if (nextPath === source) {
    throw new RedirectValidationError("Redirect destination must not target the same path");
  }

  const visited = new Set<string>([source]);
  let current = nextPath;
  let depth = 0;

  while (depth < LOOP_MAX_DEPTH) {
    if (visited.has(current)) {
      throw new RedirectValidationError("Redirect loop detected");
    }
    visited.add(current);

    const [rows] = await pool.query(
      `SELECT id, source_path, destination, is_active
       FROM redirects
       WHERE source_path = ? AND is_active = 1
       LIMIT 1`,
      [current]
    );
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return;

    const row = list[0] as { id: number; destination: string };

    // UPDATE replaces this row; its OLD source mapping is absent from the future graph.
    if (params.excludeId != null && Number(row.id) === Number(params.excludeId)) {
      return;
    }

    const continueDest = String(row.destination);

    if (isExternalDestination(continueDest)) return;

    const hopPath = extractInternalDestinationPath(continueDest);
    if (hopPath === null) return;

    if (hopPath === source || visited.has(hopPath)) {
      throw new RedirectValidationError("Redirect loop detected");
    }

    current = hopPath;
    depth += 1;
  }

  throw new RedirectValidationError("Redirect chain exceeds maximum depth");
}

export interface ValidatedRedirectInput {
  source_path: string;
  destination: string;
  status_code: RedirectStatusCode;
  is_active: 0 | 1;
}

export async function validateRedirectInput(
  raw: {
    source_path?: unknown;
    destination?: unknown;
    status_code?: unknown;
    is_active?: unknown;
  },
  options: { excludeId?: number | null; statusRequired?: boolean } = {}
): Promise<ValidatedRedirectInput> {
  const source_path = normalizeRedirectSource(raw.source_path);
  if (isProtectedRedirectSource(source_path)) {
    throw new RedirectValidationError("Source path is protected and cannot be redirected");
  }

  const destination = validateRedirectDestination(raw.destination);
  const status_code = normalizeRedirectStatus(raw.status_code, {
    required: !!options.statusRequired,
  });
  const is_active = normalizeIsActive(raw.is_active, true);

  await assertNoRedirectLoop({
    sourcePath: source_path,
    destination,
    excludeId: options.excludeId ?? null,
  });

  return { source_path, destination, status_code, is_active };
}

function isMysqlDuplicate(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

function isMysqlNoSuchTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ER_NO_SUCH_TABLE"
  );
}

export async function createRedirect(raw: {
  source_path?: unknown;
  destination?: unknown;
  status_code?: unknown;
  is_active?: unknown;
}): Promise<RedirectRecord> {
  const input = await validateRedirectInput(raw);
  await ensureRedirectsTable();

  try {
    const [result] = await pool.query(
      `INSERT INTO redirects (source_path, destination, status_code, is_active)
       VALUES (?, ?, ?, ?)`,
      [input.source_path, input.destination, input.status_code, input.is_active]
    );
    const insertId = Number((result as { insertId?: number }).insertId || 0);
    const created = await getRedirectById(insertId);
    if (!created) {
      throw new Error("Redirect create failed");
    }
    return created;
  } catch (err) {
    if (isMysqlDuplicate(err)) {
      throw new RedirectConflictError("A redirect with this source path already exists");
    }
    throw err;
  }
}

export async function updateRedirect(raw: {
  id?: unknown;
  source_path?: unknown;
  destination?: unknown;
  status_code?: unknown;
  is_active?: unknown;
}): Promise<RedirectRecord> {
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RedirectValidationError("Valid redirect id is required");
  }

  await ensureRedirectsTable();
  const existing = await getRedirectById(id);
  if (!existing) {
    throw new RedirectNotFoundError();
  }

  const input = await validateRedirectInput(raw, { excludeId: id });

  try {
    await pool.query(
      `UPDATE redirects
       SET source_path = ?, destination = ?, status_code = ?, is_active = ?
       WHERE id = ?`,
      [input.source_path, input.destination, input.status_code, input.is_active, id]
    );
  } catch (err) {
    if (isMysqlDuplicate(err)) {
      throw new RedirectConflictError("A redirect with this source path already exists");
    }
    throw err;
  }

  const updated = await getRedirectById(id);
  if (!updated) {
    throw new RedirectNotFoundError();
  }
  return updated;
}

export async function deleteRedirect(id: number): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new RedirectValidationError("Valid redirect id is required");
  }
  await ensureRedirectsTable();
  const [result] = await pool.query(`DELETE FROM redirects WHERE id = ?`, [id]);
  const affected = Number((result as { affectedRows?: number }).affectedRows || 0);
  if (affected < 1) {
    throw new RedirectNotFoundError();
  }
}
