/**
 * Central server-side RBAC for every admin API (Phase 2 P3b).
 *
 * - One permission table (role -> "resource:action") and one enforcement helper.
 * - requirePermission() wraps requireAdmin(): same-origin gate (unsafe methods), cookie session,
 *   fail-closed 503, 401 without a session, and 403 when the role lacks the permission.
 * - Denials use a GENERIC body ({ error: "Forbidden" }). Role names and permission names are
 *   never echoed to the client.
 * - No schema change; roles come from admin_sessions / admin_staff exactly as before.
 *
 * Policy is stricter than (or equal to) what the routes enforced before. Never loosen.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdmin, type AdminRole, type AdminSession } from "./adminAuth";
import { auditThrottle, recordAudit } from "./auditLog";
import pool from "./db";

export type { AdminRole };

export type AdminPermission =
  | "dashboard:view"
  | "orders:view"
  | "orders:update"
  | "orders:delete"
  | "orders:export"
  | "customers:view"
  | "products:view"
  | "products:write"
  | "categories:view"
  | "categories:write"
  | "coupons:view"
  | "coupons:write"
  | "sections:write"
  | "site_content:write"
  | "site_content:write_branding"
  | "site_content:manage"
  | "blog:write"
  | "faqs:write"
  | "search:query"
  | "redirects:manage"
  | "uploads:content"
  | "uploads:receipts"
  | "uploads:branding"
  | "uploads:favicon"
  | "staff:view"
  | "staff:write"
  | "tax:manage"
  | "audit:view"
  | "settings:order_protection"
  | "settings:accounts"
  | "settings:shipping"
  | "customers:block";

export const ALL_ADMIN_ROLES: readonly AdminRole[] = ["super_admin", "manager", "writer"];

const SUPER_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  "dashboard:view",
  "orders:view",
  "orders:update",
  "orders:delete",
  "orders:export",
  "customers:view",
  "products:view",
  "products:write",
  "categories:view",
  "categories:write",
  "coupons:view",
  "coupons:write",
  "sections:write",
  "site_content:write",
  "site_content:write_branding",
  "site_content:manage",
  "blog:write",
  "faqs:write",
  "search:query",
  "redirects:manage",
  "uploads:content",
  "uploads:receipts",
  "uploads:branding",
  "uploads:favicon",
  "staff:view",
  "staff:write",
  "tax:manage",
  "audit:view",
  "settings:order_protection",
  "settings:accounts",
  "settings:shipping",
  "customers:block",
];

/**
 * Manager: catalogue, orders (no delete), coupons, sections, site-content (non-branding),
 * FAQs, blog, redirects, dashboard summary, search, order export.
 * NOT: staff, tax, order delete, branding/site-settings keys, favicon/branding uploads, audit.
 */
const MANAGER_PERMISSIONS: readonly AdminPermission[] = [
  "dashboard:view",
  "orders:view",
  "orders:update",
  "orders:export",
  "customers:view",
  "products:view",
  "products:write",
  "categories:view",
  "categories:write",
  "coupons:view",
  "coupons:write",
  "sections:write",
  "site_content:write",
  "blog:write",
  "faqs:write",
  "search:query",
  "redirects:manage",
  "uploads:content",
  "uploads:receipts",
  "customers:block",
];

/**
 * Writer: blog, FAQs, site-content text (non-branding / non-SEO-critical keys),
 * own scoped search (blog + FAQs only, enforced in lib/adminSearchQuery.ts),
 * and content uploads for blog images. Nothing else.
 * Branding/SEO-critical keys still require site_content:write_branding (super_admin).
 */
const WRITER_PERMISSIONS: readonly AdminPermission[] = [
  "blog:write",
  "faqs:write",
  "site_content:write",
  "search:query",
  "uploads:content",
];

export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  super_admin: SUPER_ADMIN_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  writer: WRITER_PERMISSIONS,
};

function isAdminRole(role: unknown): role is AdminRole {
  return role === "super_admin" || role === "manager" || role === "writer";
}

/** Unknown / missing roles never hold a permission (fail closed). */
export function hasPermission(role: unknown, permission: AdminPermission): boolean {
  if (!isAdminRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function rolesWithPermission(permission: AdminPermission): AdminRole[] {
  return ALL_ADMIN_ROLES.filter((role) => hasPermission(role, permission));
}

function sendForbidden(res: NextApiResponse): void {
  res.status(403).json({ error: "Forbidden" });
}

/** At most one access_denied audit row per (staff, permission) per 10 minutes per process. */
const ACCESS_DENIED_WINDOW_MS = 10 * 60 * 1000;

function routePathOnly(req: NextApiRequest): string {
  const raw = typeof req.url === "string" ? req.url : "";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Fire-and-forget access_denied audit after a VALID session was denied (403).
 * Never awaited by callers — 403 body/timing stay unchanged. No row for 401/503.
 */
function fireAccessDeniedAudit(
  session: AdminSession,
  permission: AdminPermission,
  req?: NextApiRequest
): void {
  const staffKey =
    session.staffId == null
      ? session.isMaster
        ? "master"
        : "none"
      : String(session.staffId);
  const { record } = auditThrottle(
    `access_denied:${staffKey}:${permission}`,
    ACCESS_DENIED_WINDOW_MS
  );
  if (!record) return;

  const detail: Record<string, unknown> = { permission };
  if (req) {
    detail.method = typeof req.method === "string" ? req.method : null;
    detail.route = routePathOnly(req);
  }

  void recordAudit(pool, {
    actor: session,
    action: "access_denied",
    entityType: "permission",
    entityId: permission,
    summary: "Access denied",
    detail,
    req: req ?? null,
  });
}

/**
 * Authenticate (requireAdmin) and authorize in one call.
 * Returns the session when allowed; otherwise has already sent 401/403/503 and returns null.
 */
export async function requirePermission(
  req: NextApiRequest,
  res: NextApiResponse,
  permission: AdminPermission
): Promise<AdminSession | null> {
  const session = await requireAdmin(req, res);
  if (!session) return null;
  if (!hasPermission(session.role, permission)) {
    sendForbidden(res);
    fireAccessDeniedAudit(session, permission, req);
    return null;
  }
  return session;
}

/**
 * Second-stage check for routes whose required permission depends on the request payload
 * (upload folder, site-content keys). Sends a generic 403 and returns false on denial.
 */
export function requireSessionPermission(
  session: AdminSession,
  res: NextApiResponse,
  permission: AdminPermission
): boolean {
  if (hasPermission(session.role, permission)) return true;
  sendForbidden(res);
  fireAccessDeniedAudit(session, permission);
  return false;
}

/**
 * site_content keys edited ONLY from the Super Admin "Site Settings" tab (branding, SEO defaults,
 * social, hero slides, favicon, WhatsApp button). Managers keep the Content Editor keys and the
 * contact_* / whatsapp_number / low-stock keys their UI already saves.
 */
export const SUPER_ADMIN_ONLY_SITE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "site_title",
  "site_tagline",
  "site_logo_url",
  "favicon_url",
  "og_default_image",
  "whatsapp_icon_url",
  "whatsapp_btn_title",
  "site_meta_description",
  "site_keywords",
  "hero_slide_1",
  "hero_slide_2",
  "hero_slide_3",
  "hero_slide_4",
  "social_instagram",
  "social_facebook",
  "social_tiktok",
]);

export function isSuperAdminOnlySiteContentKey(key: unknown): boolean {
  return SUPER_ADMIN_ONLY_SITE_CONTENT_KEYS.has(String(key ?? "").trim());
}

/** Upload folders (pages/api/upload.ts allow-list) -> required permission. */
export const UPLOAD_FOLDER_PERMISSION: Readonly<Record<string, AdminPermission>> = {
  "sandy/products": "uploads:content",
  "sandy/receipts": "uploads:receipts",
  "sandy/logo": "uploads:branding",
  "sandy/hero-slides": "uploads:branding",
  "sandy/whatsapp-icon": "uploads:branding",
  "sandy/og": "uploads:branding",
};

export function permissionForUploadFolder(folder: string): AdminPermission | null {
  return UPLOAD_FOLDER_PERMISSION[folder] ?? null;
}

// ---------------------------------------------------------------------------
// Endpoint registry (single source of truth for tests + INVENTORY cross-check)
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AdminEndpointPolicy {
  /** pages/api route, e.g. /api/admin-orders */
  route: string;
  method: HttpMethod;
  /** Optional discriminating query string, e.g. "customers=1" */
  query?: string;
  permission: AdminPermission;
}

export function endpointKey(e: { method: string; route: string; query?: string }): string {
  return `${e.method} ${e.route}${e.query ? `?${e.query}` : ""}`;
}

export const ADMIN_ENDPOINT_POLICY: readonly AdminEndpointPolicy[] = [
  { route: "/api/admin-dashboard-summary", method: "GET", permission: "dashboard:view" },

  { route: "/api/admin-orders", method: "GET", permission: "orders:view" },
  { route: "/api/admin-orders", method: "GET", query: "badge=1", permission: "orders:view" },
  { route: "/api/admin-orders", method: "GET", query: "recent=1", permission: "orders:view" },
  { route: "/api/admin-orders", method: "GET", query: "customers=1", permission: "customers:view" },
  { route: "/api/admin-orders", method: "PATCH", permission: "orders:update" },
  { route: "/api/admin-orders", method: "DELETE", permission: "orders:delete" },
  { route: "/api/admin-orders-export", method: "GET", permission: "orders:export" },
  { route: "/api/admin-receipt/[file]", method: "GET", permission: "orders:view" },

  { route: "/api/admin-products", method: "GET", permission: "products:view" },
  { route: "/api/admin-products", method: "GET", query: "tax_classes=1", permission: "products:view" },
  { route: "/api/admin-products", method: "POST", permission: "products:write" },
  { route: "/api/admin-products", method: "PUT", permission: "products:write" },
  { route: "/api/admin-products", method: "PATCH", permission: "products:write" },
  { route: "/api/admin-products", method: "DELETE", permission: "products:write" },

  { route: "/api/categories", method: "GET", permission: "categories:view" },
  { route: "/api/categories", method: "POST", permission: "categories:write" },
  { route: "/api/categories", method: "PUT", permission: "categories:write" },
  { route: "/api/categories", method: "DELETE", permission: "categories:write" },

  { route: "/api/coupons", method: "GET", permission: "coupons:view" },
  { route: "/api/coupons", method: "POST", permission: "coupons:write" },
  { route: "/api/coupons", method: "PUT", permission: "coupons:write" },
  { route: "/api/coupons", method: "DELETE", permission: "coupons:write" },

  { route: "/api/sections", method: "POST", permission: "sections:write" },
  { route: "/api/sections", method: "PUT", permission: "sections:write" },

  { route: "/api/site-content", method: "POST", permission: "site_content:write" },
  { route: "/api/site-content", method: "PUT", permission: "site_content:manage" },
  { route: "/api/site-content", method: "DELETE", permission: "site_content:manage" },

  { route: "/api/blog", method: "POST", permission: "blog:write" },
  { route: "/api/blog", method: "PUT", permission: "blog:write" },
  { route: "/api/blog", method: "DELETE", permission: "blog:write" },

  { route: "/api/faqs", method: "POST", permission: "faqs:write" },
  { route: "/api/faqs", method: "PUT", permission: "faqs:write" },
  { route: "/api/faqs", method: "DELETE", permission: "faqs:write" },

  { route: "/api/admin-search", method: "GET", permission: "search:query" },

  { route: "/api/admin-redirects", method: "GET", permission: "redirects:manage" },
  { route: "/api/admin-redirects", method: "POST", permission: "redirects:manage" },
  { route: "/api/admin-redirects", method: "PUT", permission: "redirects:manage" },
  { route: "/api/admin-redirects", method: "DELETE", permission: "redirects:manage" },

  { route: "/api/admin-staff", method: "GET", permission: "staff:view" },
  { route: "/api/admin-staff", method: "POST", permission: "staff:write" },
  { route: "/api/admin-staff", method: "PUT", permission: "staff:write" },
  { route: "/api/admin-staff", method: "DELETE", permission: "staff:write" },

  { route: "/api/admin-tax", method: "GET", permission: "tax:manage" },
  { route: "/api/admin-tax", method: "POST", permission: "tax:manage" },
  { route: "/api/admin-tax", method: "PUT", permission: "tax:manage" },

  { route: "/api/admin-audit-log", method: "GET", permission: "audit:view" },
  { route: "/api/admin-audit-log", method: "GET", query: "export=csv", permission: "audit:view" },

  { route: "/api/admin-blacklist", method: "GET", permission: "customers:block" },
  { route: "/api/admin-blacklist", method: "POST", permission: "customers:block" },
  { route: "/api/admin-blacklist", method: "PATCH", permission: "customers:block" },
  { route: "/api/admin-blacklist", method: "DELETE", permission: "customers:block" },

  { route: "/api/admin-order-protection", method: "GET", permission: "settings:order_protection" },
  { route: "/api/admin-otp-health", method: "POST", permission: "settings:order_protection" },
  { route: "/api/admin-accounts-settings", method: "GET", permission: "settings:accounts" },

  { route: "/api/admin-shipping-zones", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-shipping-zones", method: "POST", permission: "settings:shipping" },
  { route: "/api/admin-shipping-zones", method: "PATCH", permission: "settings:shipping" },
  { route: "/api/admin-shipping-zones", method: "DELETE", permission: "settings:shipping" },
  { route: "/api/admin-couriers", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-couriers", method: "POST", permission: "settings:shipping" },
  { route: "/api/admin-couriers", method: "PATCH", permission: "settings:shipping" },
  { route: "/api/admin-couriers", method: "DELETE", permission: "settings:shipping" },
  { route: "/api/admin-shipping-settings", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-shipping-areas", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-shipping-areas", method: "POST", permission: "settings:shipping" },
  { route: "/api/admin-shipping-areas", method: "PATCH", permission: "settings:shipping" },
  { route: "/api/admin-shipping-areas", method: "DELETE", permission: "settings:shipping" },
  { route: "/api/admin-riders", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-riders", method: "POST", permission: "settings:shipping" },
  { route: "/api/admin-riders", method: "PATCH", permission: "settings:shipping" },
  { route: "/api/admin-riders", method: "DELETE", permission: "settings:shipping" },
  { route: "/api/admin-pickup-points", method: "GET", permission: "settings:shipping" },
  { route: "/api/admin-pickup-points", method: "POST", permission: "settings:shipping" },
  { route: "/api/admin-pickup-points", method: "PATCH", permission: "settings:shipping" },
  { route: "/api/admin-pickup-points", method: "DELETE", permission: "settings:shipping" },

  { route: "/api/upload", method: "POST", permission: "uploads:content" },
  { route: "/api/upload-favicon", method: "POST", permission: "uploads:favicon" },
];

/**
 * Auth-lifecycle routes: not permission gated (they establish / report / end a session).
 * Listed so the test can prove every pages/api file is classified.
 */
export const ADMIN_SESSION_ROUTES: readonly string[] = [
  "/api/admin-login",
  "/api/admin-session",
  "/api/admin-logout",
  "/api/admin-change-password",
];

/**
 * Routes that must stay reachable without an admin session for the storefront.
 * Several (blog, faqs, sections, site-content, coupons) are mixed: public GET (or public validate)
 * with admin-gated writes, see ADMIN_ENDPOINT_POLICY.
 */
export const PUBLIC_API_ROUTES: readonly string[] = [
  "/api/blog",
  "/api/contact",
  "/api/coupons",
  "/api/faqs",
  "/api/favicon",
  "/api/orders",
  "/api/products",
  "/api/public-categories",
  "/api/search",
  "/api/sections",
  "/api/site-content",
  "/api/tax-quote",
  "/api/shipping-locations",
  "/api/track",
  "/api/upload-receipt",
  "/api/checkout/eligibility",
  "/api/checkout/otp-start",
  "/api/checkout/otp-verify",
  // Customer accounts (BATCH-09): flag-gated 404 when off; customer-cookie auth, never admin.
  "/api/account/login-start",
  "/api/account/login-verify",
  "/api/account/logout",
  "/api/account/me",
  "/api/account/addresses",
  "/api/account/wishlist",
  "/api/account/profile",
  "/api/account/delete",
  "/api/account/orders/index",
  "/api/account/orders/claim",
  "/api/account/orders/[orderId]",
];
