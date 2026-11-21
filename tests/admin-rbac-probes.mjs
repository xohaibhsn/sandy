/**
 * Shared write-safe probes for the RBAC tests (HTTP + in-process handler tests).
 * Keyed by endpointKey() from lib/adminPermissions.ts; `ok` = accepted statuses for ALLOWED roles.
 */
// ---- write-safe probes, keyed by endpointKey(). `ok` = accepted statuses for ALLOWED roles.
export const NOPE = "RBAC-HTTP-NOPE";
export const BAD_URL = "javascript:alert(1)";
export const PROBES = {
  "GET /api/admin-dashboard-summary": { url: "/api/admin-dashboard-summary", ok: [200] },

  "GET /api/admin-orders": { url: "/api/admin-orders?page=1&pageSize=10", ok: [200] },
  "GET /api/admin-orders?badge=1": { url: "/api/admin-orders?badge=1", ok: [200] },
  "GET /api/admin-orders?recent=1": { url: "/api/admin-orders?recent=1", ok: [200] },
  "GET /api/admin-orders?customers=1": { url: "/api/admin-orders?customers=1&page=1&pageSize=10", ok: [200] },
  "PATCH /api/admin-orders": { url: "/api/admin-orders", body: { order_id: NOPE, status: "confirmed" }, ok: [404] },
  "DELETE /api/admin-orders": { url: "/api/admin-orders", body: { order_id: NOPE }, ok: [404] },
  "GET /api/admin-orders-export": { url: "/api/admin-orders-export", ok: [200] },
  "GET /api/admin-receipt/[file]": { url: "/api/admin-receipt/ORD-NOPE.png", ok: [404] },

  "GET /api/admin-products": { url: "/api/admin-products", ok: [200] },
  "GET /api/admin-products?tax_classes=1": { url: "/api/admin-products?tax_classes=1", ok: [200, 503] },
  "POST /api/admin-products": { url: "/api/admin-products", body: {}, ok: [400] },
  "PUT /api/admin-products": { url: "/api/admin-products", body: {}, ok: [400] },
  "PATCH /api/admin-products": { url: "/api/admin-products", body: { id: 999999999, active: 1 }, ok: [404] },
  "DELETE /api/admin-products": { url: "/api/admin-products?id=-1", ok: [200] },

  "GET /api/categories": { url: "/api/categories", ok: [200] },
  "POST /api/categories": { url: "/api/categories", body: {}, ok: [400] },
  "PUT /api/categories": { url: "/api/categories", body: { id: 999999999 }, ok: [404] },
  "DELETE /api/categories": { url: "/api/categories?id=999999999", ok: [404] },

  "GET /api/coupons": { url: "/api/coupons", ok: [200] },
  "POST /api/coupons": { url: "/api/coupons", body: {}, ok: [400] },
  "PUT /api/coupons": { url: "/api/coupons", body: { id: -1, code: NOPE, type: "fixed", value: 1 }, ok: [200] },
  "DELETE /api/coupons": { url: "/api/coupons?id=-1", ok: [200] },

  "POST /api/sections": { url: "/api/sections", body: {}, ok: [400] },
  "PUT /api/sections": { url: "/api/sections?action=bogus", body: {}, ok: [400] },

  "POST /api/site-content": {
    url: "/api/site-content",
    body: { updates: [{ key: "home_hero_btn_link", value: "https://evil.example/x" }] },
    ok: [400],
  },
  "PUT /api/site-content": {
    url: "/api/site-content",
    body: { content_key: "home_hero_btn_link", content_value: "https://evil.example/x" },
    ok: [400],
  },
  "DELETE /api/site-content": { url: `/api/site-content?key=${NOPE.toLowerCase()}`, ok: [200] },

  "POST /api/blog": { url: "/api/blog", body: { title: NOPE, featured_image: BAD_URL }, ok: [400] },
  "PUT /api/blog": { url: "/api/blog", body: { id: -1, title: NOPE, featured_image: BAD_URL }, ok: [400] },
  "DELETE /api/blog": { url: "/api/blog?id=-1", ok: [200] },

  // 500 accepted when local stub faqs table lacks optional columns — still proves auth passed (not 401/403).
  "POST /api/faqs": { url: "/api/faqs", body: {}, ok: [400, 500] },
  "PUT /api/faqs": { url: "/api/faqs", body: {}, ok: [400, 500] },
  "DELETE /api/faqs": { url: "/api/faqs?id=-1", ok: [200] },

  "GET /api/admin-search": { url: "/api/admin-search?q=rbacnopezz", ok: [200] },

  "GET /api/admin-redirects": { url: "/api/admin-redirects", ok: [200] },
  "POST /api/admin-redirects": { url: "/api/admin-redirects", body: {}, ok: [400] },
  "PUT /api/admin-redirects": { url: "/api/admin-redirects", body: {}, ok: [400] },
  "DELETE /api/admin-redirects": { url: "/api/admin-redirects", ok: [400] },

  "GET /api/admin-staff": { url: "/api/admin-staff", ok: [200] },
  "POST /api/admin-staff": { url: "/api/admin-staff", body: {}, ok: [400] },
  "PUT /api/admin-staff": { url: "/api/admin-staff", body: {}, ok: [400] },
  "DELETE /api/admin-staff": { url: "/api/admin-staff?id=-1", ok: [200] },

  "GET /api/admin-tax": { url: "/api/admin-tax", ok: [200, 503] },
  "POST /api/admin-tax": { url: "/api/admin-tax", body: {}, ok: [400] },
  "PUT /api/admin-tax": { url: "/api/admin-tax", body: {}, ok: [400] },

  "GET /api/admin-blacklist": { url: "/api/admin-blacklist", ok: [200, 500] },
  "POST /api/admin-blacklist": { url: "/api/admin-blacklist", body: {}, ok: [400] },
  "PATCH /api/admin-blacklist": { url: "/api/admin-blacklist", body: {}, ok: [400] },
  "DELETE /api/admin-blacklist": { url: "/api/admin-blacklist", body: {}, ok: [400] },

  "GET /api/admin-order-protection": { url: "/api/admin-order-protection", ok: [200] },
  "POST /api/admin-otp-health": { url: "/api/admin-otp-health", body: {}, ok: [200] },

  "GET /api/admin-accounts-settings": { url: "/api/admin-accounts-settings", ok: [200] },

  // BATCH-12 shipping (settings:shipping, super_admin only). Write probes fail validation (400) before any write.
  "GET /api/admin-shipping-zones": { url: "/api/admin-shipping-zones", ok: [200, 503] },
  "POST /api/admin-shipping-zones": { url: "/api/admin-shipping-zones", body: {}, ok: [400] },
  "PATCH /api/admin-shipping-zones": { url: "/api/admin-shipping-zones", body: {}, ok: [400] },
  "DELETE /api/admin-shipping-zones": { url: "/api/admin-shipping-zones", body: {}, ok: [400] },
  "GET /api/admin-couriers": { url: "/api/admin-couriers", ok: [200, 503] },
  "POST /api/admin-couriers": { url: "/api/admin-couriers", body: {}, ok: [400] },
  "PATCH /api/admin-couriers": { url: "/api/admin-couriers", body: {}, ok: [400] },
  "DELETE /api/admin-couriers": { url: "/api/admin-couriers", body: {}, ok: [400] },
  "GET /api/admin-shipping-settings": { url: "/api/admin-shipping-settings", ok: [200] },

  // BATCH-17 delivery ops (settings:shipping). Write probes fail validation (400) before any write;
  // 503 = migration 0010 not applied on the test database.
  "GET /api/admin-shipping-areas": { url: "/api/admin-shipping-areas", ok: [200, 503] },
  "POST /api/admin-shipping-areas": { url: "/api/admin-shipping-areas", body: {}, ok: [400, 503] },
  "PATCH /api/admin-shipping-areas": { url: "/api/admin-shipping-areas", body: {}, ok: [400, 503] },
  "DELETE /api/admin-shipping-areas": { url: "/api/admin-shipping-areas", body: {}, ok: [400, 503] },
  "GET /api/admin-riders": { url: "/api/admin-riders", ok: [200, 503] },
  "POST /api/admin-riders": { url: "/api/admin-riders", body: {}, ok: [400, 503] },
  "PATCH /api/admin-riders": { url: "/api/admin-riders", body: {}, ok: [400, 503] },
  "DELETE /api/admin-riders": { url: "/api/admin-riders", body: {}, ok: [400, 503] },
  "GET /api/admin-pickup-points": { url: "/api/admin-pickup-points", ok: [200, 503] },
  "POST /api/admin-pickup-points": { url: "/api/admin-pickup-points", body: {}, ok: [400, 503] },
  "PATCH /api/admin-pickup-points": { url: "/api/admin-pickup-points", body: {}, ok: [400, 503] },
  "DELETE /api/admin-pickup-points": { url: "/api/admin-pickup-points", body: {}, ok: [400, 503] },

  "POST /api/upload": { url: "/api/upload", body: {}, ok: [400] },
  "POST /api/upload-favicon": { url: "/api/upload-favicon", body: {}, ok: [400] },
};

// payload-dependent permissions (second stage): [name, url, method, body, expected status per role]
export const EXTRAS = [
  // site-content: branding keys are SA only, content keys manager+
  ["site-content branding key", "/api/site-content", "POST", { updates: [{ key: "favicon_url", value: BAD_URL }] }, { writer: 403, manager: 403, super_admin: 400 }],
  ["site-content single branding key", "/api/site-content", "POST", { key: "site_logo_url", value: BAD_URL }, { writer: 403, manager: 403, super_admin: 400 }],
  ["site-content content key", "/api/site-content", "POST", { updates: [{ key: "home_hero_btn_link", value: "https://evil.example/x" }] }, { writer: 400, manager: 400, super_admin: 400 }],
  ["site-content mixed keys", "/api/site-content", "POST", { updates: [{ key: "home_hero_btn_link", value: "/ok" }, { key: "hero_slide_1", value: BAD_URL }] }, { writer: 403, manager: 403, super_admin: 400 }],
  // BATCH-12: shipping_enabled needs settings:shipping (super_admin); an invalid value fails validation (400) before any write
  ["site-content shipping flag", "/api/site-content", "POST", { key: "shipping_enabled", value: "2" }, { writer: 403, manager: 403, super_admin: 400 }],
  ["site-content shipping flag (batch)", "/api/site-content", "POST", { updates: [{ key: "home_hero_btn_link", value: "/ok" }, { key: "shipping_enabled", value: "2" }] }, { writer: 403, manager: 403, super_admin: 400 }],
  // uploads: folder ownership
  ["upload default folder", "/api/upload", "POST", {}, { writer: 400, manager: 400, super_admin: 400 }],
  ["upload products folder", "/api/upload", "POST", { folder: "sandy/products" }, { writer: 400, manager: 400, super_admin: 400 }],
  ["upload receipts folder", "/api/upload", "POST", { folder: "sandy/receipts" }, { writer: 403, manager: 400, super_admin: 400 }],
  ["upload logo folder", "/api/upload", "POST", { folder: "sandy/logo" }, { writer: 403, manager: 403, super_admin: 400 }],
  ["upload hero folder", "/api/upload", "POST", { folder: "sandy/hero-slides" }, { writer: 403, manager: 403, super_admin: 400 }],
  ["upload whatsapp folder", "/api/upload", "POST", { folder: "sandy/whatsapp-icon" }, { writer: 403, manager: 403, super_admin: 400 }],
  ["upload og folder", "/api/upload", "POST", { folder: "sandy/og" }, { writer: 403, manager: 403, super_admin: 400 }],
  ["upload unknown folder", "/api/upload", "POST", { folder: "sandy/../etc" }, { writer: 400, manager: 400, super_admin: 400 }],
];
