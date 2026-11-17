/**
 * Phase 2 P3b — table-driven RBAC check for EVERY admin API endpoint x method x role
 * (none / writer / manager / super_admin) against a local next server (DB = sandy_test_local).
 *
 * Expected status comes from the policy (lib/adminPermissions.ts ADMIN_ENDPOINT_POLICY):
 *   no cookie             -> 401
 *   role lacks permission -> 403 with the GENERIC body {"error":"Forbidden"} (no role/permission names)
 *   role has permission   -> NOT 401/403 and one of the probe's expected validation/success statuses
 * Probes are write-safe: they use invalid payloads / nonexistent ids so nothing is mutated.
 *
 * Preflight runs tests/admin-rbac-policy.test.mjs (registry <-> source <-> INVENTORY.md), then
 * every registry entry MUST have a probe here (a new/missing endpoint fails the run).
 *
 * Env: BASE_URL (default http://127.0.0.1:4330), SANDY_TEST_DB_PASSWORD, INVENTORY_PATH (optional)
 * Run: node tests/admin-rbac-auth-http.mjs
 *
 * Mints sessions straight into admin_sessions (names prefixed `rbac-http-`) and removes only those.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { EXTRAS, NOPE, PROBES } from "./admin-rbac-probes.mjs";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:4330").replace(/\/+$/, "");
const NAME_PREFIX = "rbac-http-";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}

// ---- preflight: static policy / INVENTORY cross-check
const pre = spawnSync(process.execPath, [path.join(root, "tests", "admin-rbac-policy.test.mjs")], {
  encoding: "utf8",
  env: process.env,
});
if (pre.status !== 0) {
  console.error(pre.stdout, pre.stderr);
  console.error("ADMIN_RBAC_HTTP_FAIL preflight (policy / INVENTORY) failed");
  process.exit(1);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});
process.removeAllListeners("warning");
const P = await import(pathToFileURL(path.join(root, "lib/adminPermissions.ts")).href);
const { ADMIN_ENDPOINT_POLICY, endpointKey, hasPermission, PUBLIC_API_ROUTES } = P;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
});

function hashSessionToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

async function ensureSessions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token_hash CHAR(64) NOT NULL,
      staff_id INT NULL,
      is_master TINYINT(1) NOT NULL DEFAULT 0,
      role VARCHAR(32) NOT NULL,
      name VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_sessions_token_hash (token_hash)
    )
  `);
}

async function mint(role) {
  const raw = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)`,
    [hashSessionToken(raw), null, role === "super_admin" ? 1 : 0, role, `${NAME_PREFIX}${role}`, expires]
  );
  return raw;
}

/** Same-origin requests: unsafe methods carry Origin = BASE (admin same-origin gate). */
async function hit(url, cookie, { method = "GET", body, headers = {}, origin = BASE } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = `sAdminSession=${cookie}`;
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (unsafe && origin) h.Origin = origin;
  let payload;
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, json };
}

const ROLES = ["writer", "manager", "super_admin"];
const results = {};
let assertions = 0;
const check = (label, cond, msg) => {
  assertions += 1;
  assert.ok(cond, `${label}: ${msg}`);
};
const GENERIC_403 = { error: "Forbidden" };
const LEAK = /super_admin|manager|writer|permission|role/i;

function assert403Generic(label, r) {
  check(label, r.status === 403, `expected 403 got ${r.status} ${r.text.slice(0, 160)}`);
  assertions += 1;
  assert.deepEqual(r.json, GENERIC_403, `${label}: 403 body must be generic`);
  check(label, !LEAK.test(r.text), `403 body leaks role/permission text: ${r.text.slice(0, 160)}`);
}

async function main() {
  await ensureSessions();
  const cookies = { none: null };
  for (const role of ROLES) cookies[role] = await mint(role);

  // ---- every registry endpoint has a probe, and no probe is orphaned
  const regKeys = ADMIN_ENDPOINT_POLICY.map(endpointKey);
  for (const k of regKeys) check(k, PROBES[k], "registry endpoint has no HTTP probe (add one)");
  for (const k of Object.keys(PROBES)) check(k, regKeys.includes(k), "probe for endpoint not in registry");

  // ---- endpoint x method x role matrix
  let cells = 0;
  for (const e of ADMIN_ENDPOINT_POLICY) {
    const key = endpointKey(e);
    const probe = PROBES[key];
    const init = { method: e.method, body: probe.body };

    const none = await hit(probe.url, cookies.none, init);
    cells += 1;
    check(`${key} [none]`, none.status === 401, `expected 401 got ${none.status} ${none.text.slice(0, 160)}`);
    results[`${key} none`] = none.status;

    for (const role of ROLES) {
      const r = await hit(probe.url, cookies[role], init);
      cells += 1;
      const label = `${key} [${role}]`;
      if (hasPermission(role, e.permission)) {
        check(label, r.status !== 401 && r.status !== 403, `allowed role was denied: ${r.status} ${r.text.slice(0, 160)}`);
        check(label, probe.ok.includes(r.status), `expected one of ${probe.ok} got ${r.status} ${r.text.slice(0, 160)}`);
      } else {
        assert403Generic(label, r);
      }
      results[`${key} ${role}`] = r.status;
    }
  }

  // ---- payload-dependent permissions (second stage)
  const extras = EXTRAS;
  for (const [name, url, method, body, expected] of extras) {
    for (const role of ROLES) {
      const r = await hit(url, cookies[role], { method, body });
      const label = `extra:${name} [${role}]`;
      if (expected[role] === 403) assert403Generic(label, r);
      else check(label, r.status === expected[role], `expected ${expected[role]} got ${r.status} ${r.text.slice(0, 160)}`);
      results[label] = r.status;
    }
    const none = await hit(url, null, { method, body });
    check(`extra:${name} [none]`, none.status === 401, `expected 401 got ${none.status}`);
  }

  // ---- header / body role spoofing does not escalate (cookie session is the only source of role)
  const spoof = await hit("/api/admin-staff", cookies.writer, {
    headers: { "x-admin-role": "super_admin", "x-admin-session": cookies.super_admin },
  });
  assert403Generic("spoof headers writer->staff", spoof);
  const spoofBody = await hit("/api/admin-orders", cookies.manager, {
    method: "DELETE",
    body: { order_id: NOPE, role: "super_admin" },
  });
  assert403Generic("spoof body manager->order delete", spoofBody);

  // ---- same-origin gate still wins for unsafe methods (even for super_admin)
  const xo = await hit("/api/admin-staff", cookies.super_admin, { method: "POST", body: {}, origin: "https://evil.example" });
  check("cross-origin SA", xo.status === 403, `expected 403 got ${xo.status}`);
  const noOrigin = await hit("/api/admin-staff", cookies.super_admin, { method: "POST", body: {}, origin: "" });
  check("no-origin SA", noOrigin.status === 403, `expected 403 got ${noOrigin.status}`);

  // ---- session route: any role reads ONLY its own session
  const sess0 = await hit("/api/admin-session", null);
  check("session none", sess0.status === 200 && sess0.json?.authenticated === false, JSON.stringify(sess0.json));
  for (const role of ROLES) {
    const s = await hit("/api/admin-session", cookies[role]);
    check(`session ${role}`, s.status === 200 && s.json?.authenticated === true && s.json?.role === role, JSON.stringify(s.json));
  }

  // ---- public routes stay public (no 401/403 without a session)
  const publicProbes = [
    ["GET", "/api/products"],
    ["GET", "/api/public-categories"],
    ["GET", "/api/blog"],
    ["GET", "/api/faqs"],
    ["GET", "/api/sections?page=home"],
    ["GET", "/api/site-content?page=home"],
    ["GET", "/api/search?q=test"],
    ["POST", "/api/coupons?action=validate", {}],
    ["POST", "/api/upload-receipt", {}],
  ];
  for (const [method, url, body] of publicProbes) {
    const r = await hit(url, null, { method, body });
    check(`public ${method} ${url}`, r.status !== 401 && r.status !== 403 && r.status < 500, `got ${r.status} ${r.text.slice(0, 120)}`);
  }
  for (const route of PUBLIC_API_ROUTES) check(`public list ${route}`, route.startsWith("/api/"), "bad route");

  console.log(
    "ADMIN_RBAC_HTTP_PASS",
    JSON.stringify({ base: BASE, endpoints: regKeys.length, cells, extras: extras.length, assertions })
  );
  return results;
}

async function cleanup() {
  try {
    await pool.query("DELETE FROM admin_sessions WHERE name LIKE ?", [`${NAME_PREFIX}%`]);
    await pool.end();
  } catch {
    /* ignore */
  }
}

main()
  .then(cleanup)
  .catch(async (e) => {
    console.error("ADMIN_RBAC_HTTP_FAIL", e);
    await cleanup();
    process.exit(1);
  });

