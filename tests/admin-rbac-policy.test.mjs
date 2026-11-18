/**
 * Phase 2 P3b — static RBAC policy checks (NO database, NO server).
 *
 * 1. D3 permission matrix for lib/adminPermissions.ts (hasPermission / ROLE_PERMISSIONS).
 * 2. Source scan of every pages/api route: every file is classified (admin-gated / session /
 *    public); no route uses requireAdmin/requireRole directly; every requirePermission() call
 *    names a permission that the registry assigns to that route.
 * 3. Registry <-> INVENTORY.md cross-check (a missing or extra endpoint, wrong permission or
 *    wrong allowed-role set fails).
 *
 * Env: INVENTORY_PATH (default: sandy-artifacts/SANDY-BATCH-04/phase2/INVENTORY.md)
 * Run: node tests/admin-rbac-policy.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.removeAllListeners("warning");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[mc]?[jt]sx?$/.test(specifier)
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

const P = await import(pathToFileURL(path.join(root, "lib/adminPermissions.ts")).href);
const {
  ADMIN_ENDPOINT_POLICY,
  ADMIN_SESSION_ROUTES,
  PUBLIC_API_ROUTES,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_SITE_CONTENT_KEYS,
  endpointKey,
  hasPermission,
  isSuperAdminOnlySiteContentKey,
  permissionForUploadFolder,
  rolesWithPermission,
} = P;

const INVENTORY_PATH =
  process.env.INVENTORY_PATH ||
  "C:\\Users\\LENOVO\\OneDrive\\Desktop\\Web Dev\\sandy-artifacts\\SANDY-BATCH-04\\phase2\\INVENTORY.md";

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};
const sections = [];
function check(name, fn) {
  try {
    fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

const ROLES = ["super_admin", "manager", "writer"];
const roleCode = { super_admin: "SA", manager: "M", writer: "W" };
const codes = (perm) => rolesWithPermission(perm).map((r) => roleCode[r]).join(",");

check("D3 matrix", () => {
  const D3 = {
    // permission: [SA, M, W]
    "dashboard:view": [1, 1, 0],
    "orders:view": [1, 1, 0],
    "orders:update": [1, 1, 0], // status change + cancel with reason
    "orders:delete": [1, 0, 0], // manager NOT delete
    "orders:export": [1, 1, 0],
    "customers:view": [1, 1, 0],
    "products:view": [1, 1, 0],
    "products:write": [1, 1, 0],
    "categories:view": [1, 1, 0],
    "categories:write": [1, 1, 0],
    "coupons:view": [1, 1, 0],
    "coupons:write": [1, 1, 0],
    "sections:write": [1, 1, 0],
    "site_content:write": [1, 1, 1], // D3: writer may edit non-branding site-content text
    "site_content:write_branding": [1, 0, 0],
    "site_content:manage": [1, 0, 0],
    "blog:write": [1, 1, 1],
    "faqs:write": [1, 1, 1],
    "search:query": [1, 1, 1],
    "redirects:manage": [1, 1, 0],
    "uploads:content": [1, 1, 1],
    "uploads:receipts": [1, 1, 0],
    "uploads:branding": [1, 0, 0],
    "uploads:favicon": [1, 0, 0],
    "staff:view": [1, 0, 0],
    "staff:write": [1, 0, 0],
    "tax:manage": [1, 0, 0],
    "audit:view": [1, 0, 0],
    "settings:order_protection": [1, 0, 0],
    "settings:accounts": [1, 0, 0],
    "settings:shipping": [1, 0, 0],
    "customers:block": [1, 1, 0],
  };
  const known = new Set(Object.keys(D3));
  for (const role of ROLES) {
    for (const perm of ROLE_PERMISSIONS[role]) ok(known.has(perm), `unlisted permission ${perm} granted to ${role}`);
  }
  for (const [perm, [sa, m, w]] of Object.entries(D3)) {
    eq(hasPermission("super_admin", perm), !!sa, `SA ${perm}`);
    eq(hasPermission("manager", perm), !!m, `M ${perm}`);
    eq(hasPermission("writer", perm), !!w, `W ${perm}`);
  }
  // super_admin holds EVERY permission that exists.
  const allPerms = new Set(Object.values(ROLE_PERMISSIONS).flat());
  for (const perm of allPerms) ok(hasPermission("super_admin", perm), `SA missing ${perm}`);
  // Fail closed for unknown roles.
  for (const bad of [undefined, null, "", "admin", "SUPER_ADMIN", "root", 0, {}]) {
    for (const perm of allPerms) eq(hasPermission(bad, perm), false, `unknown role ${String(bad)} ${perm}`);
  }
  // Writer holds blog, faqs, site-content text, search, content uploads.
  eq([...ROLE_PERMISSIONS.writer].sort(), ["blog:write", "faqs:write", "search:query", "site_content:write", "uploads:content"]);
});

check("site-content + upload folder policy", () => {
  for (const k of ["site_logo_url", "favicon_url", "og_default_image", "hero_slide_1", "social_tiktok", "site_title"]) {
    ok(isSuperAdminOnlySiteContentKey(k), k);
  }
  // Keys the manager UI saves must NOT be SA-only.
  for (const k of ["contact_email", "contact_phone", "contact_whatsapp", "whatsapp_number", "contact_telegram", "admin_low_stock_threshold", "home_hero_title", "privacy_content"]) {
    ok(!isSuperAdminOnlySiteContentKey(k), `manager key ${k} must stay writable`);
  }
  ok(SUPER_ADMIN_ONLY_SITE_CONTENT_KEYS.size >= 16);
  eq(permissionForUploadFolder("sandy/products"), "uploads:content");
  eq(permissionForUploadFolder("sandy/receipts"), "uploads:receipts");
  for (const f of ["sandy/logo", "sandy/hero-slides", "sandy/whatsapp-icon", "sandy/og"]) {
    eq(permissionForUploadFolder(f), "uploads:branding");
  }
  eq(permissionForUploadFolder("sandy/anything-else"), null);
});

// ---------------------------------------------------------------- source scan
const apiDir = path.join(root, "pages", "api");
/** Recurse so nested routes (e.g. pages/api/checkout/eligibility.ts) are classified. */
function listApiTsFiles(dir, relBase = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...listApiTsFiles(full, rel));
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}
const apiFiles = listApiTsFiles(apiDir);
const routeOf = (f) => `/api/${f.replace(/\.ts$/, "").replace(/\\/g, "/")}`;
const src = Object.fromEntries(apiFiles.map((f) => [routeOf(f), fs.readFileSync(path.join(apiDir, f), "utf8")]));

const registryRoutes = new Set(ADMIN_ENDPOINT_POLICY.map((e) => e.route));
const sessionRoutes = new Set(ADMIN_SESSION_ROUTES);
const publicOnly = new Set(PUBLIC_API_ROUTES);

check("registry sanity", () => {
  const keys = ADMIN_ENDPOINT_POLICY.map(endpointKey);
  eq(new Set(keys).size, keys.length, "duplicate registry keys");
  for (const e of ADMIN_ENDPOINT_POLICY) {
    ok(Object.values(ROLE_PERMISSIONS).flat().includes(e.permission), `${endpointKey(e)}: unknown permission ${e.permission}`);
    ok(registryRoutes.has(e.route) && src[e.route], `${e.route}: no pages/api file`);
  }
  for (const r of [...sessionRoutes, ...publicOnly]) ok(src[r], `${r}: no pages/api file`);
});

check("every pages/api file is classified", () => {
  for (const route of Object.keys(src)) {
    const classified = registryRoutes.has(route) || sessionRoutes.has(route) || publicOnly.has(route);
    ok(classified, `UNCLASSIFIED route ${route}: add it to ADMIN_ENDPOINT_POLICY / ADMIN_SESSION_ROUTES / PUBLIC_API_ROUTES`);
  }
});

check("no direct requireAdmin/requireRole in routes (finding 7)", () => {
  for (const [route, text] of Object.entries(src)) {
    ok(!/\brequireAdmin\b/.test(text), `${route} uses requireAdmin directly`);
    ok(!/\brequireRole\b/.test(text), `${route} uses requireRole directly`);
  }
});

check("admin routes call requirePermission; public-only routes never do", () => {
  for (const route of registryRoutes) {
    ok(/\brequirePermission\(/.test(src[route]), `${route} does not call requirePermission`);
  }
  for (const route of Object.keys(src)) {
    if (!registryRoutes.has(route)) {
      ok(!/\brequirePermission\(/.test(src[route]), `${route} (not in registry) calls requirePermission`);
    }
  }
  // getAdminSession is only allowed for the session route and the optional-admin public GETs.
  const sessionUsers = Object.entries(src)
    .filter(([, t]) => /\bgetAdminSession\b/.test(t))
    .map(([r]) => r)
    .sort();
  eq(sessionUsers, ["/api/admin-session", "/api/blog", "/api/faqs", "/api/sections"]);
});

check("requirePermission() permissions match registry per route", () => {
  const callRe = /requirePermission\(\s*(?:req,\s*res,\s*)?([\s\S]*?)\)/g;
  const strRe = /['"]([a-z_]+:[a-z_]+)['"]/g;
  for (const route of registryRoutes) {
    const allowed = new Set(ADMIN_ENDPOINT_POLICY.filter((e) => e.route === route).map((e) => e.permission));
    // Routes with payload-dependent second stage:
    if (route === "/api/upload") ["uploads:receipts", "uploads:branding"].forEach((p) => allowed.add(p));
    if (route === "/api/site-content") {
      // second-stage permissions: branding keys and the COD order-protection keys
      allowed.add("site_content:write_branding");
      allowed.add("settings:order_protection");
      allowed.add("settings:accounts");
      allowed.add("settings:shipping");
    }
    const text = src[route];
    // Every permission-shaped literal in the route file (covers computed permissions in admin-orders).
    const everyPerm = new Set(Object.values(ROLE_PERMISSIONS).flat());
    const used = new Set();
    for (const s of text.matchAll(strRe)) if (everyPerm.has(s[1])) used.add(s[1]);
    ok(used.size > 0, `${route}: no literal permission found`);
    for (const p of used) ok(allowed.has(p), `${route}: source uses ${p} not in registry`);
    // every registry permission appears literally in the route (or is the shared admin-orders map).
    for (const p of ADMIN_ENDPOINT_POLICY.filter((e) => e.route === route).map((e) => e.permission)) {
      ok(text.includes(`"${p}"`) || text.includes(`'${p}'`), `${route}: registry permission ${p} not enforced in source`);
    }
  }
  void callRe;
});

check("D3 specifics are enforced in source", () => {
  ok(/orders:delete/.test(src["/api/admin-orders"]), "orders DELETE permission");
  ok(/tax:manage/.test(src["/api/admin-tax"]));
  ok(/staff:view/.test(src["/api/admin-staff"]) && /staff:write/.test(src["/api/admin-staff"]));
  eq(ADMIN_ENDPOINT_POLICY.find((e) => e.route === "/api/admin-orders" && e.method === "DELETE").permission, "orders:delete");
  eq(rolesWithPermission("orders:delete"), ["super_admin"]);
  eq(rolesWithPermission("orders:update"), ["super_admin", "manager"]);
  eq(rolesWithPermission("tax:manage"), ["super_admin"]);
  eq(rolesWithPermission("staff:view"), ["super_admin"]);
  // generic denial body: no role names in the helper's response literals
  const perm = fs.readFileSync(path.join(root, "lib", "adminPermissions.ts"), "utf8");
  const sendForbidden = perm.match(/function sendForbidden[\s\S]*?\n}/)?.[0] || "";
  ok(/\{ error: "Forbidden" \}/.test(sendForbidden) && !/role|permission|super_admin|manager|writer/.test(sendForbidden));
});

// ---------------------------------------------------------------- INVENTORY cross-check
check("INVENTORY.md matches registry", () => {
  ok(fs.existsSync(INVENTORY_PATH), `INVENTORY not found at ${INVENTORY_PATH} (set INVENTORY_PATH)`);
  const text = fs.readFileSync(INVENTORY_PATH, "utf8");
  const section1 = text.split(/^## 1\./m)[1]?.split(/^## 2\./m)[0] || "";
  ok(section1.length > 0, "INVENTORY section 1 missing");
  const rows = [];
  for (const line of section1.split(/\r?\n/)) {
    if (!line.startsWith("| `/api/")) continue;
    const c = line.split("|").map((s) => s.trim().replace(/`/g, ""));
    // ["", route, method, query, before, permission, allowed, change, ""]
    const permCell = c[5].split(" ")[0];
    rows.push({ route: c[1], method: c[2], query: c[3] === "—" ? "" : c[3], permission: permCell, allowed: c[6] });
  }
  const invMap = new Map(rows.map((r) => [endpointKey({ ...r }), r]));
  eq(invMap.size, rows.length, "duplicate INVENTORY rows");
  for (const e of ADMIN_ENDPOINT_POLICY) {
    const k = endpointKey(e);
    const row = invMap.get(k);
    ok(row, `INVENTORY missing endpoint ${k}`);
    eq(row.permission, e.permission, `INVENTORY permission mismatch for ${k}`);
    eq(row.allowed, codes(e.permission), `INVENTORY allowed roles mismatch for ${k}`);
  }
  const regKeys = new Set(ADMIN_ENDPOINT_POLICY.map(endpointKey));
  for (const k of invMap.keys()) ok(regKeys.has(k), `INVENTORY lists unknown endpoint ${k}`);

  // Public + session routes must be listed.
  for (const r of [...PUBLIC_API_ROUTES, ...ADMIN_SESSION_ROUTES]) {
    ok(text.includes(`\`${r}\``), `INVENTORY does not mention ${r}`);
  }
});

console.log("ADMIN_RBAC_POLICY_PASS", JSON.stringify({ sections, assertions, routes: Object.keys(src).length }));
