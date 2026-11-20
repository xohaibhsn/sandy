/**
 * SANDY-BATCH-05 — unauthenticated data reveal on GET /api/blog and GET /api/sections
 * (no database, no network).
 *
 * The REAL handlers are invoked with fake req/res objects. lib/db's pool is replaced by an in-memory
 * fake (globalThis._mysqlPool) that resolves admin sessions and evaluates the visibility filters the
 * handlers put in their SQL, so a missing filter shows up as extra rows in the response.
 *
 *   blog:     anonymous ?id=<draft>  -> null     | blog:write role -> the row
 *             anonymous list         -> published + active only
 *   sections: anonymous ?all=1       -> visible only | sections:write role -> everything
 *             writer (no sections:write) ?all=1 -> visible only
 * GET never answers 401/403.
 *
 * Run: node tests/blog-sections-reveal.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Fake sessions use staff_id NULL / is_master=1; master env must be present for getAdminSession.
if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_SHA256 && !process.env.ADMIN_PASSWORD_HASH) {
  process.env.ADMIN_PASSWORD = ["BlogRevealMaster", crypto.randomBytes(6).toString("hex")].join("");
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

const tokens = {
  writer: "a".repeat(64),
  manager: "b".repeat(64),
  super_admin: "c".repeat(64),
};
const byHash = new Map(Object.entries(tokens).map(([role, t]) => [crypto.createHash("sha256").update(t).digest("hex"), role]));

const BLOG = [
  { id: 1, title: "Published", slug: "published", status: "published", active: 1 },
  { id: 2, title: "Draft", slug: "draft", status: "draft", active: 1 },
  { id: 3, title: "Inactive", slug: "inactive", status: "published", active: 0 },
  { id: 4, title: "Legacy null status", slug: "legacy", status: null, active: 1 },
];
const SECTIONS = [
  { content_key: "home_hero", content_value: '{"title":"Visible"}', content_type: "json", page_name: "home", label: "Hero", section_order: 1, is_visible: 1 },
  { content_key: "home_secret", content_value: '{"title":"Hidden"}', content_type: "json", page_name: "home", label: "Hidden", section_order: 2, is_visible: 0 },
];

let sessionStoreDown = false;
let queries = [];
globalThis._mysqlPool = {
  query: async (sql, params = []) => {
    const text = String(sql);
    queries.push(text);
    if (/FROM admin_sessions/i.test(text) && /SELECT/i.test(text)) {
      if (sessionStoreDown) throw new Error("session store down");
      const role = byHash.get(String(params[0]));
      if (!role) return [[], []];
      return [[{ id: 1, staff_id: null, is_master: 1, role, name: `fake-${role}` }], []];
    }
    if (/FROM blog_posts WHERE id = \?/i.test(text)) {
      const restricted = /active = 1/i.test(text) && /status = "published"/i.test(text);
      const rows = BLOG.filter((r) => String(r.id) === String(params[0])).filter(
        (r) => !restricted || (r.active === 1 && (r.status === "published" || r.status === null))
      );
      return [rows, []];
    }
    if (/FROM blog_posts WHERE slug = \?/i.test(text)) {
      return [BLOG.filter((r) => r.slug === params[0] && r.status === "published" && r.active === 1), []];
    }
    if (/FROM blog_posts/i.test(text) && /ORDER BY created_at/i.test(text)) {
      const restricted = /WHERE active = 1/i.test(text);
      return [BLOG.filter((r) => !restricted || (r.active === 1 && (r.status === "published" || r.status === null))), []];
    }
    if (/FROM site_content WHERE page_name=\?/i.test(text)) {
      const restricted = /is_visible=1/i.test(text);
      return [SECTIONS.filter((r) => r.page_name === params[0] && (!restricted || r.is_visible === 1)), []];
    }
    return [[], []];
  },
  getConnection: async () => {
    throw new Error("no connection in this test");
  },
};

const blog = (await import(pathToFileURL(path.join(root, "pages/api/blog.ts")).href)).default;
const sections = (await import(pathToFileURL(path.join(root, "pages/api/sections.ts")).href)).default;

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};

function makeReq(url, role, cookieToken) {
  const u = new URL(url, "http://reveal.test");
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  const token = cookieToken ?? (role ? tokens[role] : undefined);
  return {
    method: "GET",
    url: `${u.pathname}${u.search}`,
    query,
    headers: { host: "reveal.test" },
    cookies: token ? { sAdminSession: token } : {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
      return this;
    },
  };
}

async function get(handler, url, role, cookieToken) {
  queries = [];
  const res = makeRes();
  await handler(makeReq(url, role, cookieToken), res);
  eq(res.statusCode, 200, `GET ${url} as ${role ?? "anon"} must answer 200, never 401/403`);
  return res.body;
}

const ids = (rows) => rows.map((r) => r.id).sort();
const keys = (rows) => rows.map((r) => r.key).sort();

let groups = 0;
async function group(name, fn) {
  try {
    await fn();
    groups += 1;
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

await group("blog ?id= : anonymous sees published+active rows only", async () => {
  eq(await get(blog, "/api/blog?id=2"), null, "draft -> null");
  eq(await get(blog, "/api/blog?id=3"), null, "inactive -> null");
  eq((await get(blog, "/api/blog?id=1")).title, "Published");
  eq((await get(blog, "/api/blog?id=4")).title, "Legacy null status");
  eq(await get(blog, "/api/blog?id=999"), null);
});

await group("blog ?id= : forged / unknown session is still anonymous", async () => {
  eq(await get(blog, "/api/blog?id=2", null, "d".repeat(64)), null);
  eq(await get(blog, "/api/blog?id=2", null, "not-a-token"), null);
});

await group("blog ?id= : any role with blog:write gets the row", async () => {
  for (const role of ["writer", "manager", "super_admin"]) {
    eq((await get(blog, "/api/blog?id=2", role)).title, "Draft", `${role}: draft`);
    eq((await get(blog, "/api/blog?id=3", role)).title, "Inactive", `${role}: inactive`);
  }
});

await group("blog list: anonymous published only, blog:write sees all", async () => {
  eq(ids(await get(blog, "/api/blog")), [1, 4], "anonymous list");
  for (const role of ["writer", "manager", "super_admin"]) {
    eq(ids(await get(blog, "/api/blog", role)), [1, 2, 3, 4], `${role} list`);
  }
});

await group("blog: session store failure degrades to the public view", async () => {
  sessionStoreDown = true;
  try {
    eq(await get(blog, "/api/blog?id=2", "super_admin"), null);
    eq(ids(await get(blog, "/api/blog", "super_admin")), [1, 4]);
  } finally {
    sessionStoreDown = false;
  }
});

await group("blog ?slug= unchanged", async () => {
  eq((await get(blog, "/api/blog?slug=published")).id, 1);
  eq(await get(blog, "/api/blog?slug=draft"), null);
});

await group("sections: anonymous ?all=1 is ignored (visible only)", async () => {
  eq(keys(await get(sections, "/api/sections?page=home&all=1")), ["home_hero"]);
  eq(keys(await get(sections, "/api/sections?page=home")), ["home_hero"]);
  eq(keys(await get(sections, "/api/sections?page=home&all=1", null, "e".repeat(64))), ["home_hero"]);
});

await group("sections: sections:write roles get everything with all=1", async () => {
  for (const role of ["manager", "super_admin"]) {
    eq(keys(await get(sections, "/api/sections?page=home&all=1", role)), ["home_hero", "home_secret"], role);
    eq(keys(await get(sections, "/api/sections?page=home", role)), ["home_hero"], `${role} without all`);
  }
});

await group("sections: writer lacks sections:write so all=1 is ignored", async () => {
  eq(keys(await get(sections, "/api/sections?page=home&all=1", "writer")), ["home_hero"]);
});

await group("sections: session store failure degrades to the public view", async () => {
  sessionStoreDown = true;
  try {
    eq(keys(await get(sections, "/api/sections?page=home&all=1", "super_admin")), ["home_hero"]);
  } finally {
    sessionStoreDown = false;
  }
});

await group("sections: plain public reads do not touch the session store", async () => {
  await get(sections, "/api/sections?page=home");
  eq(queries.some((q) => /admin_sessions/i.test(q)), false);
});

console.log("BLOG_SECTIONS_REVEAL_PASS", JSON.stringify({ groups, assertions }));
process.exit(0);
