/**
 * SANDY-BATCH-05 Phase 3 (P1c) - admin/CMS handlers run WITHOUT runtime DDL against databases built
 * ONLY from migrations/0001-0004 (+ tax SQL). Real pages/api handlers are invoked in-process.
 *
 *   Main DB    : sandy_mig_admin           (all tables present)       env SANDY_P1C_DB overrides, must match /^sandy_mig_[a-z_]+$/
 *   Child DB   : sandy_mig_admin_noredir   (same, but redirects table missing) - run by a child process
 *                (module state such as the redirects probe cache starts clean there)
 *   Env        : SANDY_TEST_DB_PASSWORD (required, never printed)
 *   Build both : node <harness>/setup-mig-dbs.mjs   (drops everything, applies the migrations; test setup only)
 *
 * Proves:
 *  - no handler issues DDL (schema of the 8 admin tables is byte-identical before/after a full CRUD run)
 *  - no destructive "initialiser" side effects (IPTV/UK text, obsolete-looking FAQs, coupons are left alone)
 *  - login/session work with pre-created admin_sessions / admin_staff
 *  - redirects present => full admin CRUD + public lookup/proxy redirect
 *  - redirects missing => admin API 503 {"error":"Redirects storage not configured"}, public pass-through, nothing created
 *  - admin_sessions missing => fail closed (503), nothing created; admin_staff missing => master login still works
 *
 * Run: node tests/admin-schema-p1c.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { installTsResolveHook, importFromRoot, makeReq, makeRes, root } from "./orders-test-support.mjs";

const SELF = fileURLToPath(import.meta.url);
const CHILD = process.argv.includes("--noredir");
const DB = CHILD ? "sandy_mig_admin_noredir" : process.env.SANDY_P1C_DB || "sandy_mig_admin";
if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}
if (!/^sandy_mig_[a-z_]+$/.test(DB)) {
  console.error("refusing to run against database", DB);
  process.exit(2);
}

let n = 0;
const failures = [];
function ok(cond, msg) {
  n += 1;
  if (!cond) failures.push(msg);
}
function eq(a, b, msg) {
  n += 1;
  try {
    assert.deepEqual(a, b);
  } catch {
    failures.push(`${msg}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}

installTsResolveHook();
// proxy.ts imports "next/server" (extensionless): map it for plain Node ESM.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});
process.env.ADMIN_PASSWORD = crypto.randomBytes(12).toString("hex"); // per-run throwaway master password
const STAFF_PW = crypto.randomBytes(12).toString("hex");
const WRONG_PW = crypto.randomBytes(12).toString("hex");
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ADMIN_PASSWORD_SHA256;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: DB,
  charset: "utf8mb4",
  connectionLimit: 4,
});
globalThis._mysqlPool = pool;
const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0];

const ADMIN_TABLES = ["categories", "coupons", "admin_staff", "admin_sessions", "faqs", "redirects", "site_content", "blog_posts"];
async function tableExists(t) {
  return (await q("SELECT 1 AS x FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t])).length > 0;
}
async function schemaSig() {
  const out = {};
  for (const t of ADMIN_TABLES) {
    if (!(await tableExists(t))) {
      out[t] = null;
      continue;
    }
    const row = await one(`SHOW CREATE TABLE \`${t}\``);
    out[t] = String(row["Create Table"]).replace(/ AUTO_INCREMENT=\d+/, "");
  }
  return out;
}

const HOST = "p1c.test";
let ipSeq = 0;
function req(method, url, { cookie, body, ip } = {}) {
  const u = new URL(url, `http://${HOST}`);
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  const headers = { host: HOST };
  if (method !== "GET") headers.origin = `http://${HOST}`;
  return makeReq({
    method,
    url: `${u.pathname}${u.search}`,
    query,
    body,
    cookies: cookie ? { sAdminSession: cookie } : {},
    headers,
    ip: ip || `198.51.100.${(ipSeq++ % 250) + 1}`,
  });
}
const handlers = {};
async function call(route, method, url, opts) {
  if (!handlers[route]) handlers[route] = (await importFromRoot(`pages/api/${route}.ts`)).default;
  const res = makeRes();
  await handlers[route](req(method, url, opts), res);
  return res;
}

const auth = await importFromRoot("lib/adminAuth.ts");
const mkSession = (role = "super_admin") =>
  auth.createAdminSession({ staffId: null, isMaster: role === "super_admin", role, name: `p1c-${role}` });

// ------------------------------------------------------------------ static source checks (both modes cheap)
function staticChecks() {
  const gone = ["lib/ensureCategories.ts", "lib/ensureShopTables.ts", "lib/ensureOrderIdempotency.ts"];
  for (const g of gone) ok(!existsSync(path.join(root, g)), `${g} must not exist`);
  const files = [
    "lib/adminAuth.ts",
    "lib/redirects.ts",
    "lib/categorySlug.ts",
    "pages/api/admin-login.ts",
    "pages/api/admin-staff.ts",
    "pages/api/coupons.ts",
    "pages/api/site-content.ts",
    "pages/api/sections.ts",
    "pages/api/faqs.ts",
    "pages/api/blog.ts",
    "pages/api/categories.ts",
    "pages/api/admin-products.ts",
    "pages/api/admin-redirects.ts",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    ok(!/\b(CREATE\s+TABLE|ALTER\s+TABLE|MODIFY\s+COLUMN|DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE)\b/i.test(src), `${f}: no DDL`);
    ok(!/ensure\w*(Initialized|Table|Tables)\b/.test(src), `${f}: no ensure*Initialized / ensure*Table`);
    ok(!/INSERT\s+IGNORE/i.test(src), `${f}: no INSERT IGNORE seeding`);
    ok(!/REPLACE\s*\(\s*(content_value|title|excerpt|content)\b/i.test(src), `${f}: no REPLACE() rewriting`);
    ok(!/DELETE\s+FROM\s+faqs\s+WHERE\s+question\s+IN/i.test(src), `${f}: no obsolete-FAQ delete`);
  }
  eq(JSON.parse(readFileSync(path.join(root, "scripts/qa/runtime-ddl-allowlist.json"), "utf8")), {}, "allowlist is empty");
  const gate = spawnSync(process.execPath, [path.join(root, "scripts/qa/check-runtime-ddl.mjs")], { encoding: "utf8" });
  eq(gate.status, 0, "check-runtime-ddl exit code with empty allowlist");
}

function finish(label) {
  const summary = { db: DB, assertions: n, failures: failures.length };
  if (failures.length) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    console.error(`${label}_FAIL ${JSON.stringify(summary)}`);
    process.exitCode = 1;
  } else {
    console.log(`${label}_PASS ${JSON.stringify(summary)}`);
  }
}

// ================================================================== child: redirects missing
async function childMain() {
  const [{ d }] = await q("SELECT DATABASE() AS d");
  eq(d, DB, "connected to the expected database");
  {
    // Fixture (test setup, not app code): re-apply the owner migration so every table exists again, then drop redirects.
    const c0 = await mysql.createConnection({
      host: "127.0.0.1", port: 3307, user: "sandy_test", password: process.env.SANDY_TEST_DB_PASSWORD, database: DB, multipleStatements: true, charset: "utf8mb4",
    });
    await c0.query(readFileSync(path.join(root, "migrations/0003-admin-schema.sql"), "utf8"));
    await c0.query("DROP TABLE IF EXISTS redirects");
    await c0.end();
  }
  ok(!(await tableExists("redirects")), "fixture: redirects table is missing");
  const before = await schemaSig();
  const S = await mkSession();
  const redirects = await importFromRoot("lib/redirects.ts");

  // admin API: every method => 503 + exact body, nothing created
  for (const [m, url, body] of [
    ["GET", "/api/admin-redirects"],
    ["POST", "/api/admin-redirects", { source_path: "/p1c-a", destination: "/p1c-b" }],
    ["PUT", "/api/admin-redirects", { id: 1, source_path: "/p1c-a", destination: "/p1c-b" }],
    ["DELETE", "/api/admin-redirects?id=1"],
    ["POST", "/api/admin-redirects", { source_path: "", destination: "" }], // invalid body must not mask the 503
  ]) {
    const r = await call("admin-redirects", m, url, { cookie: S, body });
    eq(r.statusCode, 503, `admin-redirects ${m} status when table missing`);
    eq(r.body, { error: "Redirects storage not configured" }, `admin-redirects ${m} body`);
  }
  // auth still enforced first
  eq((await call("admin-redirects", "GET", "/api/admin-redirects")).statusCode, 401, "no cookie => 401 (auth before storage probe)");
  ok(!(await tableExists("redirects")), "admin API did not create redirects");

  // public lookup: skips (null), does not throw, does not create
  eq(await redirects.getActiveRedirectBySource("/p1c-old"), null, "public lookup returns null when table missing");
  eq(await redirects.getActiveRedirectBySource("/p1c-old"), null, "public lookup stays null (backoff)");
  const { NextRequest } = await import("next/server");
  const proxyMod = await importFromRoot("proxy.ts");
  const pr = await proxyMod.proxy(new NextRequest(`http://${HOST}/p1c-old`));
  eq(pr.headers.get("x-middleware-next"), "1", "proxy passes through when redirects table is missing");
  eq(pr.status, 200, "proxy pass-through status");
  ok(!(await tableExists("redirects")), "public lookup did not create redirects");

  // other admin tables untouched by the above; schema signature unchanged (still no redirects)
  eq(await schemaSig(), before, "schema unchanged after redirects-missing calls");

  // now the owner runs the migration: probe cache is negative-cached briefly, then recovers
  const mig = readFileSync(path.join(root, "migrations/0003-admin-schema.sql"), "utf8");
  const c = await mysql.createConnection({
    host: "127.0.0.1", port: 3307, user: "sandy_test", password: process.env.SANDY_TEST_DB_PASSWORD, database: DB, multipleStatements: true, charset: "utf8mb4",
  });
  await c.query(mig);
  await c.end();
  ok(await tableExists("redirects"), "migration 0003 created redirects (owner step)");
  redirects.resetRedirectsStorageCache();
  eq((await call("admin-redirects", "GET", "/api/admin-redirects", { cookie: S })).statusCode, 200, "after migration the admin list works");
  await q("DROP TABLE redirects"); // restore fixture
  redirects.resetRedirectsStorageCache();

  // ---- admin_staff missing: master login still works, nothing is created
  await q("DROP TABLE admin_staff");
  const lm = await call("admin-login", "POST", "/api/admin-login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD } });
  eq(lm.statusCode, 200, "master login works without admin_staff");
  ok(String(lm.headers["set-cookie"] || "").includes("sAdminSession="), "master login sets session cookie");
  const lf = await call("admin-login", "POST", "/api/admin-login", { body: { username: "nobody@example.invalid", password: "x" } });
  eq(lf.statusCode, 401, "staff login without admin_staff => 401 (falls through, no crash)");
  const st = await call("admin-staff", "GET", "/api/admin-staff", { cookie: S });
  eq(st.statusCode, 500, "admin-staff GET with missing table => generic 500");
  eq(st.body, { error: "Server error" }, "admin-staff generic error body");
  ok(!(await tableExists("admin_staff")), "admin_staff NOT re-created by login / admin-staff");

  // ---- admin_sessions missing: fail closed
  await q("DROP TABLE admin_sessions");
  const g = await call("admin-staff", "GET", "/api/admin-staff", { cookie: S });
  eq(g.statusCode, 503, "protected route with sessions table missing => 503 (fail closed)");
  eq(g.body, { error: "Service unavailable" }, "503 body");
  const l2 = await call("admin-login", "POST", "/api/admin-login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD } });
  eq(l2.statusCode, 503, "login with sessions table missing => 503");
  ok(!String(l2.headers["set-cookie"] || "").includes("sAdminSession=") || /Max-Age=0/.test(String(l2.headers["set-cookie"])), "no session cookie issued");
  ok(!(await tableExists("admin_sessions")), "admin_sessions NOT re-created");

  // put the fixture back for the next run
  await q("DELETE FROM admin_sessions WHERE 1=0").catch(() => {});
  finish("ADMIN_SCHEMA_P1C_CHILD");
  await pool.end();
}

// ================================================================== main: everything present
async function main() {
  staticChecks();
  const [{ d }] = await q("SELECT DATABASE() AS d");
  eq(d, DB, "connected to the expected database");
  for (const t of ADMIN_TABLES) ok(await tableExists(t), `fixture: ${t} exists (built by migrations only)`);

  const before = await schemaSig();
  const S = await mkSession("super_admin");
  const redirects = await importFromRoot("lib/redirects.ts");

  // ---------- migrations-only seed sanity
  const sc = await one("SELECT COUNT(*) AS c FROM site_content");
  ok(Number(sc.c) >= 250, "0004 seeded site_content");
  eq(Number((await one("SELECT COUNT(*) AS c FROM coupons")).c), 0, "no coupons seeded (WELCOME10/SAVE5 not auto-created)");

  // ---------- login / session with pre-created tables
  const staffEmail = `p1c-staff-${crypto.randomBytes(3).toString("hex")}@example.test`;
  const create = await call("admin-staff", "POST", "/api/admin-staff", {
    cookie: S,
    body: { name: "P1C Manager", email: staffEmail, password: STAFF_PW, role: "manager" },
  });
  eq(create.statusCode, 200, "admin-staff create");
  const staffId = create.body?.id;
  const li = await call("admin-login", "POST", "/api/admin-login", { body: { username: staffEmail, password: STAFF_PW } });
  eq(li.statusCode, 200, "staff login");
  eq(li.body?.role, "manager", "staff login role");
  const staffCookie = /sAdminSession=([a-f0-9]{64})/.exec(String(li.headers["set-cookie"] || ""))?.[1];
  ok(!!staffCookie, "staff login set a 64-hex session cookie");
  const bad = await call("admin-login", "POST", "/api/admin-login", { body: { username: staffEmail, password: WRONG_PW } });
  eq(bad.statusCode, 401, "staff login wrong password");
  const lm = await call("admin-login", "POST", "/api/admin-login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD } });
  eq(lm.statusCode, 200, "master login");
  const masterCookie = /sAdminSession=([a-f0-9]{64})/.exec(String(lm.headers["set-cookie"] || ""))?.[1];
  ok(!!masterCookie, "master login set cookie");
  eq((await call("admin-staff", "GET", "/api/admin-staff", { cookie: staffCookie })).statusCode, 403, "manager cannot list staff (RBAC unchanged)");
  const list = await call("admin-staff", "GET", "/api/admin-staff", { cookie: masterCookie });
  eq(list.statusCode, 200, "master can list staff");
  ok(Array.isArray(list.body) && list.body.some((s) => s.email === staffEmail), "created staff in list");
  eq((await call("categories", "GET", "/api/categories", { cookie: staffCookie })).statusCode, 200, "manager session works on categories");
  eq((await call("admin-staff", "GET", "/api/admin-staff")).statusCode, 401, "no cookie => 401");
  // expired session is rejected
  const expiredRaw = crypto.randomBytes(32).toString("hex");
  await q("INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,DATE_SUB(NOW(), INTERVAL 1 HOUR))", [
    auth.hashSessionToken(expiredRaw), null, 1, "super_admin", "p1c-expired",
  ]);
  eq((await call("admin-staff", "GET", "/api/admin-staff", { cookie: expiredRaw })).statusCode, 401, "expired session => 401");
  // logout (destroyAdminSession) removes the row
  const lres = makeRes();
  await auth.destroyAdminSession({ cookies: { sAdminSession: masterCookie }, headers: {}, method: "POST" }, lres);
  eq((await call("admin-staff", "GET", "/api/admin-staff", { cookie: masterCookie })).statusCode, 401, "destroyed session => 401");
  // disable staff => session dies
  await call("admin-staff", "PUT", "/api/admin-staff", { cookie: S, body: { id: staffId, name: "P1C Manager", email: staffEmail, role: "manager", active: 0 } });
  eq((await call("categories", "GET", "/api/categories", { cookie: staffCookie })).statusCode, 401, "deactivated staff session => 401");

  // ---------- destructive initialisers are gone: seed "legacy" text and prove nothing rewrites it
  await q("INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES ('p1c_iptv', 'Premium IPTV & Streaming UK', 'text', 'home', 'p1c')");
  await q("UPDATE site_content SET content_value = 'Firestick UK 44 shop' WHERE content_key = 'contact_telegram'");
  await q("UPDATE site_content SET content_value = 'Firestick4UK 447000' WHERE content_key = 'site_title'");
  await q("INSERT INTO faqs (question, answer, category, sort_order) VALUES ('Do you deliver across the whole UK?', 'legacy kept', 'General', 77)");
  const blogIptv = await call("blog", "POST", "/api/blog", {
    cookie: S,
    body: { title: "P1C IPTV guide", slug: "p1c-iptv-guide", excerpt: "IPTV excerpt", content: "<p>Best IPTV tips</p>", status: "published" },
  });
  eq(blogIptv.statusCode, 200, "blog create");
  const blogId = blogIptv.body?.id;
  await q("UPDATE blog_posts SET active = NULL WHERE id = ?", [blogId]);
  await q("UPDATE site_content SET content_value = 'Leeds, United Kingdom UK' WHERE content_key = 'contact_address'");
  const hfBefore = (await one("SELECT content_value AS v FROM site_content WHERE content_key = 'home_features'")).v;
  const hhtBefore = (await one("SELECT content_value AS v FROM site_content WHERE content_key = 'home_hero_title'")).v;

  // exercise every write path of the previously-initialising handlers
  eq((await call("site-content", "POST", "/api/site-content", { cookie: S, body: { key: "contact_telegram", value: "@p1c_handle" } })).statusCode, 200, "site-content POST");
  eq((await call("site-content", "POST", "/api/site-content", { cookie: S, body: { updates: [{ key: "home_hero_title", value: "P1C hero" }] } })).statusCode, 200, "site-content POST updates");
  eq((await call("site-content", "PUT", "/api/site-content", { cookie: S, body: { content_key: "p1c_extra", content_value: "x", content_type: "text", page_name: "home", label: "p1c" } })).statusCode, 200, "site-content PUT");
  eq((await call("site-content", "DELETE", "/api/site-content?key=p1c_extra", { cookie: S })).statusCode, 200, "site-content DELETE");
  const gc = await call("site-content", "GET", "/api/site-content?page=settings");
  eq(gc.statusCode, 200, "site-content GET");
  eq((await call("sections", "POST", "/api/sections", { cookie: S, body: { key: "home_features", value: { title: "P1C Features", items: [] } } })).statusCode, 200, "sections POST");
  eq((await call("sections", "PUT", "/api/sections?action=visibility", { cookie: S, body: { key: "home_newsletter", is_visible: 0 } })).statusCode, 200, "sections visibility");
  eq((await call("sections", "PUT", "/api/sections?action=reorder", { cookie: S, body: { order: [{ key: "home_newsletter", section_order: 5 }] } })).statusCode, 200, "sections reorder");
  const gs = await call("sections", "GET", "/api/sections?page=home&all=1", { cookie: S });
  eq(gs.statusCode, 200, "sections GET (admin)");
  ok(Array.isArray(gs.body) && gs.body.some((s) => s.key === "home_hero"), "sections list has seeded home_hero");
  const gsPublic = await call("sections", "GET", "/api/sections?page=home");
  ok(Array.isArray(gsPublic.body) && !gsPublic.body.some((s) => s.key === "home_newsletter"), "hidden section not public");
  await q("UPDATE site_content SET is_visible = 1, section_order = 5 WHERE content_key = 'home_newsletter'");
  const fq = await call("faqs", "POST", "/api/faqs", { cookie: S, body: { question: "P1C question?", answer: "P1C answer", category: "General", sort_order: 3 } });
  eq(fq.statusCode, 200, "faqs POST");
  eq((await call("faqs", "PUT", "/api/faqs", { cookie: S, body: { id: fq.body?.id, question: "P1C question?", answer: "P1C answer 2", category: "General", sort_order: 4, is_visible: 1 } })).statusCode, 200, "faqs PUT");
  eq((await call("faqs", "GET", "/api/faqs")).statusCode, 200, "faqs GET");
  eq((await call("faqs", "DELETE", `/api/faqs?id=${fq.body?.id}`, { cookie: S })).statusCode, 200, "faqs DELETE");
  eq((await call("blog", "PUT", "/api/blog", {
    cookie: S,
    body: { id: blogId, title: "P1C IPTV guide", slug: "p1c-iptv-guide", excerpt: "IPTV excerpt", content: "<p>Best IPTV tips</p>", status: "published" },
  })).statusCode, 200, "blog PUT");
  eq((await call("blog", "GET", "/api/blog", { cookie: S })).statusCode, 200, "blog GET (admin)");

  // ---------- nothing was rewritten / deleted / seeded behind our back
  eq((await one("SELECT content_value AS v FROM site_content WHERE content_key = 'p1c_iptv'")).v, "Premium IPTV & Streaming UK", "IPTV text in site_content NOT rewritten");
  eq((await one("SELECT content_value AS v FROM site_content WHERE content_key = 'site_title'")).v, "Firestick4UK 447000", "Firestick title NOT migrated");
  eq((await one("SELECT content_value AS v FROM site_content WHERE content_key = 'contact_telegram'")).v, "@p1c_handle", "only the explicit POST changed contact_telegram");
  eq(Number((await one("SELECT COUNT(*) AS c FROM faqs WHERE question = 'Do you deliver across the whole UK?'")).c), 1, "obsolete-looking FAQ NOT deleted");
  eq((await one("SELECT content_value AS v FROM site_content WHERE content_key = 'contact_address'")).v, "Leeds, United Kingdom UK", "UK address NOT migrated");
  const bp = await one("SELECT title, excerpt, content, active FROM blog_posts WHERE id = ?", [blogId]);
  ok(/IPTV/.test(bp.title) && /IPTV/.test(bp.excerpt) && /IPTV/.test(bp.content), "IPTV text in blog_posts NOT rewritten");
  ok(!/Streaming/.test(`${bp.title}${bp.excerpt}${bp.content}`), "no 'Streaming' replacement text appeared");
  eq(bp.active, null, "blog_posts.active IS NULL NOT auto-fixed by requests (UPDATE initialiser removed)");
  eq(Number((await one("SELECT COUNT(*) AS c FROM coupons WHERE code IN ('WELCOME10','SAVE5')")).c), 0, "sample coupons NOT re-created");
  await q("DELETE FROM site_content WHERE content_key = 'p1c_iptv'");
  await q("DELETE FROM faqs WHERE question = 'Do you deliver across the whole UK?'");
  await q("DELETE FROM blog_posts WHERE id = ?", [blogId]);
  await q("UPDATE site_content SET content_value = '' WHERE content_key IN ('contact_telegram')");
  await q("UPDATE site_content SET content_value = 'Lahore, Pakistan' WHERE content_key = 'contact_address'");
  await q("UPDATE site_content SET content_value = ? WHERE content_key = 'home_features'", [hfBefore]);
  await q("UPDATE site_content SET content_value = ? WHERE content_key = 'home_hero_title'", [hhtBefore]);
  await q("UPDATE site_content SET section_order = 5, is_visible = 1 WHERE content_key = 'home_newsletter'");
  await q("UPDATE site_content SET content_value = 'S&Y' WHERE content_key = 'site_title'");

  // ---------- coupons CRUD (no seed, no create)
  const code = `P1C${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const cp = await call("coupons", "POST", "/api/coupons", { cookie: S, body: { code, type: "percentage", value: 10, minimum_order: 0 } });
  eq(cp.statusCode, 200, "coupons POST");
  const cpId = cp.body?.id;
  eq((await call("coupons", "GET", "/api/coupons", { cookie: S })).body?.length, 1, "coupons list has exactly the one created (no seeds)");
  const val = await call("coupons", "POST", "/api/coupons?action=validate", { body: { code, cart_total: 100 } });
  eq(val.body?.valid, true, "public coupon validate");
  eq(val.body?.discount_amount, 10, "coupon discount");
  eq((await call("coupons", "PUT", "/api/coupons", { cookie: S, body: { id: cpId, code, type: "fixed", value: 5, minimum_order: 0, is_active: 1 } })).statusCode, 200, "coupons PUT");
  eq((await call("coupons", "DELETE", `/api/coupons?id=${cpId}`, { cookie: S })).statusCode, 200, "coupons DELETE");
  eq((await call("coupons", "GET", "/api/coupons")).statusCode, 401, "coupons list needs auth");

  // ---------- categories CRUD (admin-products category lookup needs the table, never creates it)
  const cat = await call("categories", "POST", "/api/categories", { cookie: S, body: { name: "P1C Category" } });
  eq(cat.statusCode, 201, "categories POST");
  const catId = cat.body?.id;
  eq((await call("categories", "PUT", "/api/categories", { cookie: S, body: { id: catId, name: "P1C Category", description: "d" } })).statusCode, 200, "categories PUT");
  eq((await call("categories", "GET", "/api/categories", { cookie: S })).body?.some((c) => c.slug === "p1c-category"), true, "categories GET has slug from lib/categorySlug");
  eq((await call("categories", "DELETE", `/api/categories?id=${catId}`, { cookie: S })).statusCode, 200, "categories DELETE");

  // ---------- redirects present: full CRUD + public lookup + proxy
  redirects.resetRedirectsStorageCache();
  const src = `/p1c-old-${crypto.randomBytes(2).toString("hex")}`;
  const rc = await call("admin-redirects", "POST", "/api/admin-redirects", { cookie: S, body: { source_path: src, destination: "/p1c-new", status_code: 301 } });
  eq(rc.statusCode, 200, "redirects POST");
  const rid = rc.body?.redirect?.id;
  eq((await call("admin-redirects", "POST", "/api/admin-redirects", { cookie: S, body: { source_path: src, destination: "/p1c-other" } })).statusCode, 409, "redirects duplicate => 409");
  eq((await call("admin-redirects", "POST", "/api/admin-redirects", { cookie: S, body: { source_path: "/api/x", destination: "/p1c-other" } })).statusCode, 400, "protected source => 400");
  const rl = await call("admin-redirects", "GET", "/api/admin-redirects", { cookie: S });
  eq(rl.statusCode, 200, "redirects GET");
  ok(Array.isArray(rl.body) && rl.body.some((r) => r.id === rid), "created redirect listed");
  const hit = await redirects.getActiveRedirectBySource(src);
  eq(hit?.destination, "/p1c-new", "public lookup finds active redirect");
  const { NextRequest } = await import("next/server");
  const proxyMod = await importFromRoot("proxy.ts");
  const pr = await proxyMod.proxy(new NextRequest(`http://${HOST}${src}`));
  eq(pr.status, 301, "proxy redirects with 301");
  eq(new URL(pr.headers.get("location")).pathname, "/p1c-new", "proxy Location");
  eq((await call("admin-redirects", "PUT", "/api/admin-redirects", { cookie: S, body: { id: rid, source_path: src, destination: "/p1c-new2", status_code: 302, is_active: 1 } })).body?.redirect?.status_code, 302, "redirects PUT");
  eq((await call("admin-redirects", "DELETE", `/api/admin-redirects?id=${rid}`, { cookie: S })).statusCode, 200, "redirects DELETE");
  eq(await redirects.getActiveRedirectBySource(src), null, "deleted redirect no longer found");
  eq((await call("admin-redirects", "GET", "/api/admin-redirects")).statusCode, 401, "redirects needs auth");
  eq((await call("admin-redirects", "GET", "/api/admin-redirects", { cookie: await mkSession("writer") })).statusCode, 403, "writer cannot manage redirects");

  // ---------- no DDL anywhere in the whole run
  eq(await schemaSig(), before, "schema of all 8 admin tables byte-identical before/after the full CRUD run");

  // cleanup helper sessions / staff
  await q("DELETE FROM admin_sessions WHERE name LIKE 'p1c-%' OR name LIKE 'P1C %'");
  await q("DELETE FROM admin_staff WHERE email LIKE 'p1c-staff-%'");
  await q("DELETE FROM admin_sessions WHERE role = 'manager' AND staff_id IS NOT NULL");

  // ---------- child process: redirects / admin_staff / admin_sessions missing (fresh module state)
  const noRedirDb = "sandy_mig_admin_noredir";
  const child = spawnSync(process.execPath, ["--no-warnings", SELF, "--noredir"], { encoding: "utf8", env: process.env });
  process.stdout.write(child.stdout || "");
  if (child.stderr) process.stderr.write(child.stderr);
  eq(child.status, 0, `child (${noRedirDb}: missing redirects/admin_staff/admin_sessions) exit code`);
  ok(/ADMIN_SCHEMA_P1C_CHILD_PASS/.test(child.stdout || ""), "child reported PASS");

  finish("ADMIN_SCHEMA_P1C");
  await pool.end();
}

try {
  if (CHILD) {
    await childMain();
  } else {
    await main();
  }
} catch (err) {
  console.error("ADMIN_SCHEMA_P1C_ERROR", err?.stack || err);
  process.exitCode = 1;
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
}
