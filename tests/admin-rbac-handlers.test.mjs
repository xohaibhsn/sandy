/**
 * Phase 2 P3b — in-process RBAC check of the REAL route handlers (no server, no database).
 *
 * pages/api/<route>.ts is imported and invoked with fake req/res objects; lib/db's pool is replaced by a
 * fake (global._mysqlPool) that only knows how to resolve admin sessions. For every
 * ADMIN_ENDPOINT_POLICY entry x role (none / writer / manager / super_admin):
 *   none                  -> 401
 *   role lacks permission -> 403 with the generic body {"error":"Forbidden"} (nothing else, no leaks)
 *   role has permission   -> NOT 401/403 (handler ran past the guard; any later outcome is fine here)
 * plus second-stage cases (site-content keys, upload folders) from tests/admin-rbac-probes.mjs.
 *
 * The probes are the same write-safe ones the HTTP test uses; the fake pool returns empty result sets,
 * so no handler can mutate anything even if a guard were missing.
 *
 * Run: node tests/admin-rbac-handlers.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Fake sessions use staff_id NULL / is_master=1; master env must be present for getAdminSession.
if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_SHA256 && !process.env.ADMIN_PASSWORD_HASH) {
  process.env.ADMIN_PASSWORD = ["RbacHandlerMaster", crypto.randomBytes(6).toString("hex")].join("");
}
process.removeAllListeners("warning");
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

// ---- fake pool: session lookup only; everything else returns empty result sets
const tokens = {
  writer: "a".repeat(64),
  manager: "b".repeat(64),
  super_admin: "c".repeat(64),
};
const byHash = new Map(Object.entries(tokens).map(([role, t]) => [crypto.createHash("sha256").update(t).digest("hex"), role]));
let fakeQueries = 0;
globalThis._mysqlPool = {
  query: async (sql, params = []) => {
    fakeQueries += 1;
    const text = String(sql);
    if (/FROM admin_sessions/i.test(text) && /SELECT/i.test(text)) {
      const role = byHash.get(String(params[0]));
      if (!role) return [[], []];
      return [[{ id: 1, staff_id: null, is_master: 1, role, name: `fake-${role}` }], []];
    }
    return [[], []];
  },
  getConnection: async () => {
    throw new Error("no connection in handler RBAC test");
  },
};

const P = await import(pathToFileURL(path.join(root, "lib/adminPermissions.ts")).href);
const { ADMIN_ENDPOINT_POLICY, endpointKey, hasPermission } = P;
const { PROBES, EXTRAS } = await import(pathToFileURL(path.join(root, "tests/admin-rbac-probes.mjs")).href);

const handlers = {};
async function handlerFor(route) {
  if (!handlers[route]) {
    const mod = await import(pathToFileURL(path.join(root, "pages", `${route}.ts`)).href);
    handlers[route] = mod.default;
  }
  return handlers[route];
}

const HOST = "rbac.test";
function makeReq(method, url, role, body, origin = `http://${HOST}`) {
  const u = new URL(url, `http://${HOST}`);
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  const headers = { host: HOST, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}` };
  if (method !== "GET" && origin) headers.origin = origin;
  return {
    method,
    url: `${u.pathname}${u.search}`,
    query,
    headers,
    cookies: role ? { sAdminSession: tokens[role] } : {},
    body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
    socket: { remoteAddress: "127.0.0.1" },
  };
}
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      this.ended = true;
      return this;
    },
    send(b) {
      this.body = b;
      this.ended = true;
      return this;
    },
    end(b) {
      if (b !== undefined) this.body = b;
      this.ended = true;
      return this;
    },
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
      return this;
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    write() {
      return true;
    },
    redirect() {
      this.ended = true;
    },
  };
  return res;
}

async function run(route, method, url, role, body, origin) {
  const handler = await handlerFor(route);
  const req = makeReq(method, url, role, body, origin);
  const res = makeRes();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`handler timeout ${method} ${url}`)), 15000));
  await Promise.race([handler(req, res), timeout]);
  return res;
}

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};
const LEAK = /super_admin|manager|writer|permission|role/i;
const ROLES = ["writer", "manager", "super_admin"];

function expectForbidden(res, label) {
  eq(res.statusCode, 403, `${label}: got ${res.statusCode} ${JSON.stringify(res.body)}`);
  eq(res.body, { error: "Forbidden" }, `${label}: generic body`);
  ok(!LEAK.test(JSON.stringify(res.body)), `${label}: leaked text`);
}

let cells = 0;
for (const e of ADMIN_ENDPOINT_POLICY) {
  const key = endpointKey(e);
  const probe = PROBES[key];
  ok(probe, `${key}: no probe`);

  const none = await run(e.route, e.method, probe.url, null, probe.body);
  cells += 1;
  eq(none.statusCode, 401, `${key} [none] got ${none.statusCode} ${JSON.stringify(none.body)}`);

  for (const role of ROLES) {
    const res = await run(e.route, e.method, probe.url, role, probe.body);
    cells += 1;
    const label = `${key} [${role}]`;
    if (hasPermission(role, e.permission)) {
      ok(res.statusCode !== 401 && res.statusCode !== 403, `${label}: allowed role denied (${res.statusCode})`);
    } else {
      expectForbidden(res, label);
    }
  }
}

// 503 fail-closed when the session store errors (never falls through to the handler body)
{
  const original = globalThis._mysqlPool.query;
  globalThis._mysqlPool.query = async () => {
    throw new Error("db down");
  };
  for (const e of ADMIN_ENDPOINT_POLICY) {
    const key = endpointKey(e);
    const res = await run(e.route, e.method, PROBES[key].url, "super_admin", PROBES[key].body);
    cells += 1;
    ok(res.statusCode === 503 || res.statusCode === 500, `${key}: session-store error must fail closed (got ${res.statusCode})`);
    ok(res.statusCode !== 200, `${key}: fail-closed`);
  }
  globalThis._mysqlPool.query = original;
}

// second-stage permissions (payload dependent)
let extraCells = 0;
for (const [name, url, method, body, expected] of EXTRAS) {
  const route = url.split("?")[0];
  for (const role of ROLES) {
    const res = await run(route, method, url, role, body);
    extraCells += 1;
    const label = `extra:${name} [${role}]`;
    if (expected[role] === 403) expectForbidden(res, label);
    else {
      ok(res.statusCode !== 401 && res.statusCode !== 403, `${label}: allowed role denied (${res.statusCode})`);
      ok(res.statusCode < 500 || res.statusCode === 400, `${label}: unexpected ${res.statusCode}`);
    }
  }
}

// header / body spoofing never raises the role (cookie session is the only source)
{
  const req = makeReq("GET", "/api/admin-staff", "writer");
  req.headers["x-admin-role"] = "super_admin";
  req.headers["x-admin-session"] = tokens.super_admin;
  const res = makeRes();
  await (await handlerFor("/api/admin-staff"))(req, res);
  expectForbidden(res, "spoofed headers");
  const res2 = await run("/api/admin-orders", "DELETE", "/api/admin-orders", "manager", { order_id: "X", role: "super_admin" });
  expectForbidden(res2, "spoofed body");
}

// cross-origin unsafe request is rejected even for super_admin
{
  const res = await run("/api/admin-staff", "POST", "/api/admin-staff", "super_admin", {}, "https://evil.example");
  eq(res.statusCode, 403);
  const res2 = await run("/api/admin-staff", "POST", "/api/admin-staff", "super_admin", {}, "");
  eq(res2.statusCode, 403);
}

console.log("ADMIN_RBAC_HANDLERS_PASS", JSON.stringify({ endpoints: ADMIN_ENDPOINT_POLICY.length, cells, extraCells, assertions, fakeQueries }));
process.exit(0);
