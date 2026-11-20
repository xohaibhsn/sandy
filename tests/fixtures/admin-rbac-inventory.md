# SANDY-BATCH-04 Phase 2 P3b — Admin API RBAC inventory

Base: maintained inventory (BATCH-20). Default path is tests/fixtures/admin-rbac-inventory.md. BATCH-04 artifact inventory is retired.
Policy source of truth: `lib/adminPermissions.ts` (`ROLE_PERMISSIONS`, `ADMIN_ENDPOINT_POLICY`).
Enforcement: `requirePermission(req, res, "resource:action")` -> wraps `requireAdmin` (same-origin gate for
unsafe methods, cookie session, 503 fail-closed, 401) then 403 with generic body `{"error":"Forbidden"}`.

Legend — roles: `SA` super_admin, `M` manager, `W` writer.
"Before" is what `main` enforced at 3d5c656. `TIGHTENED` = new policy is stricter than before (finding 7:
`requireAdmin` accepts ALL roles). Nothing was loosened.

Method rows below are machine-checked by `tests/admin-rbac-policy.test.mjs` and
`tests/admin-rbac-auth-http.mjs` against `ADMIN_ENDPOINT_POLICY` (a missing/extra endpoint fails the test).

## 1. Admin endpoints (permission-gated)

| Route | Method | Query | Before (guard -> roles) | Permission | Allowed | Change |
|---|---|---|---|---|---|---|
| `/api/admin-dashboard-summary` | GET | — | requireRole -> SA,M (+ redundant in-handler check) | `dashboard:view` | SA,M | none (kept) |
| `/api/admin-orders` | GET | — | requireRole -> SA,M | `orders:view` | SA,M | none |
| `/api/admin-orders` | GET | `badge=1` | requireRole -> SA,M | `orders:view` | SA,M | none |
| `/api/admin-orders` | GET | `recent=1` | requireRole -> SA,M | `orders:view` | SA,M | none |
| `/api/admin-orders` | GET | `customers=1` | requireRole -> SA,M | `customers:view` | SA,M | none |
| `/api/admin-orders` | PATCH | — | requireRole -> SA,M (status change + cancel w/ reason) | `orders:update` | SA,M | none |
| `/api/admin-orders` | DELETE | — | requireRole -> SA,M | `orders:delete` | SA | TIGHTENED (manager can no longer delete orders; D3) |
| `/api/admin-orders-export` | GET | — | requireRole -> SA,M | `orders:export` | SA,M | none |
| `/api/admin-products` | GET | — | requireAdmin -> SA,M,W (finding 7) | `products:view` | SA,M | TIGHTENED (writer 403) |
| `/api/admin-products` | GET | `tax_classes=1` | requireAdmin -> SA,M,W (finding 7) | `products:view` | SA,M | TIGHTENED (writer 403) |
| `/api/admin-products` | POST | — | requireRole -> SA,M | `products:write` | SA,M | none |
| `/api/admin-products` | PUT | — | requireRole -> SA,M | `products:write` | SA,M | none |
| `/api/admin-products` | PATCH | — | requireRole -> SA,M | `products:write` | SA,M | none |
| `/api/admin-products` | DELETE | — | requireRole -> SA,M | `products:write` | SA,M | none |
| `/api/categories` | GET | — | requireAdmin -> SA,M,W (finding 7) | `categories:view` | SA,M | TIGHTENED (writer 403) |
| `/api/categories` | POST | — | requireRole -> SA,M | `categories:write` | SA,M | none |
| `/api/categories` | PUT | — | requireRole -> SA,M | `categories:write` | SA,M | none |
| `/api/categories` | DELETE | — | requireRole -> SA,M | `categories:write` | SA,M | none |
| `/api/coupons` | GET | — | requireAdmin -> SA,M,W (finding 7) | `coupons:view` | SA,M | TIGHTENED (writer 403) |
| `/api/coupons` | POST | — | requireAdmin -> SA,M,W (finding 7) | `coupons:write` | SA,M | TIGHTENED (writer 403) |
| `/api/coupons` | PUT | — | requireAdmin -> SA,M,W (finding 7) | `coupons:write` | SA,M | TIGHTENED (writer 403) |
| `/api/coupons` | DELETE | — | requireAdmin -> SA,M,W (finding 7) | `coupons:write` | SA,M | TIGHTENED (writer 403) |
| `/api/sections` | POST | — | requireAdmin -> SA,M,W (finding 7) | `sections:write` | SA,M | TIGHTENED (writer 403) |
| `/api/sections` | PUT | — | requireAdmin -> SA,M,W (finding 7) | `sections:write` | SA,M | TIGHTENED (writer 403) |
| `/api/site-content` | POST | — | requireAdmin -> SA,M,W (finding 7) | `site_content:write` | SA,M,W | MATCH D3 (writer non-branding text; branding keys SA-only, see section 4) |
| `/api/site-content` | PUT | — | requireAdmin -> SA,M,W (finding 7) | `site_content:manage` | SA | TIGHTENED (no UI caller; arbitrary key upsert) |
| `/api/site-content` | DELETE | — | requireAdmin -> SA,M,W (finding 7) | `site_content:manage` | SA | TIGHTENED (no UI caller; key removal) |
| `/api/blog` | POST | — | requireAdmin -> SA,M,W | `blog:write` | SA,M,W | none (now explicit) |
| `/api/blog` | PUT | — | requireAdmin -> SA,M,W | `blog:write` | SA,M,W | none (now explicit) |
| `/api/blog` | DELETE | — | requireAdmin -> SA,M,W | `blog:write` | SA,M,W | none (now explicit) |
| `/api/faqs` | POST | — | requireAdmin -> SA,M,W | `faqs:write` | SA,M,W | none (now explicit) |
| `/api/faqs` | PUT | — | requireAdmin -> SA,M,W | `faqs:write` | SA,M,W | none (now explicit) |
| `/api/faqs` | DELETE | — | requireAdmin -> SA,M,W | `faqs:write` | SA,M,W | none (now explicit) |
| `/api/admin-search` | GET | — | requireAdmin -> SA,M,W; role scope in `lib/adminSearchQuery.ts` (writer = blog+FAQs only) | `search:query` | SA,M,W | none (writer scope re-verified, see tests) |
| `/api/admin-redirects` | GET | — | requireRole -> SA,M | `redirects:manage` | SA,M | none (kept; D3 silent, see ambiguous list) |
| `/api/admin-redirects` | POST | — | requireRole -> SA,M | `redirects:manage` | SA,M | none |
| `/api/admin-redirects` | PUT | — | requireRole -> SA,M | `redirects:manage` | SA,M | none |
| `/api/admin-redirects` | DELETE | — | requireRole -> SA,M | `redirects:manage` | SA,M | none |
| `/api/admin-staff` | GET | — | requireAdmin -> SA,M,W (finding 7: staff emails/roles leak) | `staff:view` | SA | TIGHTENED (manager/writer 403) |
| `/api/admin-staff` | POST | — | requireRole -> SA | `staff:write` | SA | none |
| `/api/admin-staff` | PUT | — | requireRole -> SA | `staff:write` | SA | none |
| `/api/admin-staff` | DELETE | — | requireRole -> SA | `staff:write` | SA | none |
| `/api/admin-tax` | GET | — | requireRole -> SA (+ redundant in-handler check) | `tax:manage` | SA | none (kept) |
| `/api/admin-tax` | POST | — | requireRole -> SA | `tax:manage` | SA | none |
| `/api/admin-tax` | PUT | — | requireRole -> SA | `tax:manage` | SA | none |
| `/api/admin-audit-log` | GET | — | n/a (BATCH-20) | `audit:view` | SA | NEW (BATCH-20) |
| `/api/admin-audit-log` | GET | `export=csv` | n/a (BATCH-20) | `audit:view` | SA | NEW (BATCH-20) |
| `/api/admin-blacklist` | GET | — | n/a (BATCH-07) | `customers:block` | SA,M | NEW (BATCH-07) |
| `/api/admin-blacklist` | POST | — | n/a (BATCH-07) | `customers:block` | SA,M | NEW (BATCH-07) |
| `/api/admin-blacklist` | PATCH | — | n/a (BATCH-07) | `customers:block` | SA,M | NEW (BATCH-07) |
| `/api/admin-blacklist` | DELETE | — | n/a (BATCH-07) | `customers:block` | SA,M | NEW (BATCH-07) |
| `/api/admin-order-protection` | GET | — | n/a (BATCH-07) | `settings:order_protection` | SA | NEW (BATCH-07) |
| `/api/admin-accounts-settings` | GET | — | n/a (BATCH-09) | `settings:accounts` | SA | NEW (BATCH-09) |
| `/api/admin-shipping-zones` | GET | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-shipping-zones` | POST | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-shipping-zones` | PATCH | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-shipping-zones` | DELETE | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-couriers` | GET | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-couriers` | POST | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-couriers` | PATCH | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-couriers` | DELETE | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-shipping-settings` | GET | — | n/a (BATCH-12) | `settings:shipping` | SA | NEW (BATCH-12) |
| `/api/admin-shipping-areas` | GET | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-shipping-areas` | POST | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-shipping-areas` | PATCH | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-shipping-areas` | DELETE | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-riders` | GET | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-riders` | POST | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-riders` | PATCH | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-riders` | DELETE | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-pickup-points` | GET | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-pickup-points` | POST | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-pickup-points` | PATCH | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/admin-pickup-points` | DELETE | — | n/a (BATCH-17) | `settings:shipping` | SA | NEW (BATCH-17) |
| `/api/upload` | POST | — | requireAdmin -> SA,M,W (any folder, finding 7) | `uploads:content` (+ per-folder, section 5) | SA,M,W | TIGHTENED for non-default folders |
| `/api/upload-favicon` | POST | — | requireAdmin -> SA,M,W (finding 7) | `uploads:favicon` | SA | TIGHTENED (manager/writer 403) |

No `pages/api` route still imports `requireAdmin` / `requireRole` directly (checked by the policy test).
Explicit role enforcement was MISSING (finding 7: `requireAdmin` accepts all roles) on: admin-products GET,
categories GET, coupons (all methods), sections writes, site-content (all writes), admin-staff GET, upload,
upload-favicon. Blog / FAQs / admin-search intentionally allow all three roles (D3) and are now explicit.

## 2. Session / auth lifecycle routes (not permission-gated)

| Route | Method | Behaviour | Change |
|---|---|---|---|
| `/api/admin-login` | POST | Public credential exchange; creates session; rate limited | untouched |
| `/api/admin-session` | GET | `getAdminSession`; 200 `{authenticated:false}` without session, role echoed to the caller's OWN session only | untouched |
| `/api/admin-logout` | POST | same-origin gate + destroy session cookie | untouched |

## 3. Public routes — must stay public (verified untouched)

| Route | Notes |
|---|---|
| `/api/products` | storefront GET |
| `/api/public-categories` | storefront GET |
| `/api/orders` | storefront checkout POST |
| `/api/track` | order tracking POST |
| `/api/contact` | contact form POST |
| `/api/search` | storefront search GET |
| `/api/tax-quote` | checkout tax quote POST |
| `/api/shipping-locations` | checkout areas/pickup points GET (BATCH-17; empty when flags off) |
| `/api/favicon` | favicon GET/HEAD |
| `/api/upload-receipt` | customer payment-receipt upload (rate limited, no admin session) |
| `/api/blog` | public GET (published); POST/PUT/DELETE gated above |
| `/api/faqs` | public GET (visible); POST/PUT/DELETE gated above |
| `/api/sections` | public GET; POST/PUT gated above |
| `/api/site-content` | public GET; POST/PUT/DELETE gated above |
| `/api/coupons` | public `POST ?action=validate` (checkout); all other use gated above |
| `/api/checkout/eligibility` | COD protection eligibility POST (BATCH-07) |
| `/api/checkout/otp-start` | WhatsApp OTP start POST (BATCH-07) |
| `/api/checkout/otp-verify` | WhatsApp OTP verify POST (BATCH-07) |
| `/api/account/login-start` | Customer WhatsApp OTP login start (BATCH-09; 404 when accounts_enabled=0) |
| `/api/account/login-verify` | Customer WhatsApp OTP login verify (BATCH-09) |
| `/api/account/logout` | Customer session logout (BATCH-09) |
| `/api/account/me` | Customer session me (BATCH-09) |
| `/api/account/addresses` | Customer addresses CRUD (BATCH-09) |
| `/api/account/wishlist` | Customer wishlist (BATCH-09) |
| `/api/account/profile` | Customer profile PATCH (BATCH-09) |
| `/api/account/delete` | Customer account delete (BATCH-09) |
| `/api/account/orders/index` | Customer orders list file path (BATCH-09; URL `/api/account/orders`) |
| `/api/account/orders/claim` | Claim past orders by phone_norm (BATCH-09) |
| `/api/account/orders/[orderId]` | Customer order detail (BATCH-09) |

Files not modified for these routes except the mixed ones above where ONLY the admin guard line changed
(`blog`, `faqs`, `sections`, `site-content`, `coupons`); the public branches are byte-identical.
Unmodified entirely: `products`, `public-categories`, `orders`, `track`, `contact`, `search`, `tax-quote`,
`favicon`, `upload-receipt`, `admin-login`, `admin-session`, `admin-logout` (confirm with `git diff --stat`).

## 4. site-content key policy

* Writer: site-content write for non-branding keys (D3); branding/SEO-critical keys remain SA-only.
* Manager: every key the Content Editor / Contact / Dashboard low-stock UI saves
  (including `contact_email`, `contact_phone`, `contact_whatsapp`, `whatsapp_number`, `contact_telegram`,
  `admin_low_stock_threshold`).
* Super admin only (Site Settings tab keys; matches existing UI gate, branding/SEO defaults):
  `site_title, site_tagline, site_logo_url, favicon_url, og_default_image, whatsapp_icon_url,
  whatsapp_btn_title, site_meta_description, site_keywords, hero_slide_1..4, social_instagram,
  social_facebook, social_tiktok`.
* PUT / DELETE: super admin only.

## 5. Upload folder policy (`/api/upload`)

| Folder | Permission | Roles |
|---|---|---|
| default / `sandy/products` (products, blog images, section images) | `uploads:content` | SA,M,W |
| `sandy/receipts` | `uploads:receipts` | SA,M |
| `sandy/logo`, `sandy/hero-slides`, `sandy/whatsapp-icon`, `sandy/og` | `uploads:branding` | SA |

## 6. Stricter-than-D3 items (kept strict / chosen strict)

* Coupons and Sections: D3 grants manager; API grants manager (matches the old API, which allowed any admin).
  The Sidhu UI already hides Coupons / Page Builder from managers (SA-only nav). Left as D3 at the API.
* admin-redirects: not in D3 manager list but existing code + UI = SA,M. Kept (not tightened: would break a
  visible manager nav item).
* admin-tax GET: SA only (was already). Dashboard summary: SA,M (was already).
* site-content writer access: non-branding keys only (D3). Branding keys SA-only (stricter than old requireAdmin).
* Branding site-content keys and branding uploads: SA only (UI already SA only; API was open to all roles).

## 7. Ambiguous items for the Professor

1. **Writer + site-content text** — GRANTED per D3 for non-branding keys. Branding/SEO-critical keys remain
   super_admin only (stricter than pre-RBAC requireAdmin which allowed writers to touch any key).
2. **Manager coupons/sections**: API allows (D3), UI hides. Decide whether to also open the UI or restrict the API
   to SA (one-line change in `MANAGER_PERMISSIONS`).
3. **Redirects**: D3 silent; kept SA,M.
4. **Manager vs SA-only settings keys** `contact_*`/`whatsapp_number`: the manager Content Editor "Save Contact"
   writes these (incl. order-notification `contact_email`), so they are NOT SA-only. Restricting would break
   the manager Contact tab; tell me if you want the Contact tab SA-only.
5. **Writer search scope** = blog + FAQs (existing, verified). Writer FAQ *write* is allowed by D3/API even though
   the Sidhu FAQ tab is hidden for writers (UI gate left as-is; not a 403 control).

## 8. Observations (not changed — out of scope or would alter public behaviour)

* `GET /api/sections?all=1` returns hidden sections without any session (public). Not changed.
* `GET /api/blog?id=<n>` returns any post (incl. drafts) without a session. Not changed.
* `/api/admin-staff` runs `CREATE TABLE IF NOT EXISTS` before auth (harmless, pre-existing).
* Sidhu `tab==="settings"` render has no role guard (nav hides it); API now blocks branding writes for non-SA.
* Staff PUT/DELETE allow self-demotion / self-delete (pre-existing; SA only).
* Orders `GET ?customers=1` is served by `/api/admin-orders`; permission mapped to `customers:view`.

## 9. UI changes (visible control would always 403)

* `app/sidhu/page.tsx`: hide order "Delete" (table + drawer via new optional `canDelete` prop) unless SA;
  writer dashboard keeps its 3 legacy cards but the Products card shows "—" (products GET is now 403 for
  writers, so no count is fetched or shown); boot loads of products/categories/coupons gated to SA,M (a writer
  would only get 403s). Sidhu lint unchanged at 41e/16w. No other UI changes.
* `components/admin/OrderDetailDrawer.tsx`: optional `canDelete` prop (default `true`).

## 10. Tests (all in `C:\Temp\sandy-batch04\tests`)

| File | Needs | Covers |
|---|---|---|
| `admin-rbac-policy.test.mjs` | nothing | D3 matrix, every pages/api file classified, no direct requireAdmin/requireRole, source permissions == registry, registry == this INVENTORY |
| `admin-rbac-handlers.test.mjs` | nothing (fake pool) | real route handlers x endpoint x method x role: 401 / generic 403 / not-denied, fail-closed 503, second-stage (site-content keys, upload folders), spoof + cross-origin |
| `admin-rbac-auth-http.mjs` | next server + `SANDY_TEST_DB_PASSWORD` | same matrix over HTTP (runs policy test as preflight) |
| `admin-rbac-db.test.mjs` | next server + `SANDY_TEST_DB_PASSWORD` | manager cancel OK / delete 403, writer product write 403, manager tax 403, staff SA-only, site-content keys, writer blog/FAQ + search scope, with DB row assertions |
| `harness/tests/admin-rbac-ui.spec.ts` (phase2/harness) | built app on :4320 | manager no Delete, SA Delete, writer boot requests + Products card, manager/SA boot loads |

## BATCH-20 note
SANDY-BATCH-04 phase2/INVENTORY.md is retired as the default. This in-repo fixture is the source of truth for admin-rbac-policy.
