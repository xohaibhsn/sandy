/**
 * SANDY-BATCH-05 — POST /api/contact against the local MariaDB (127.0.0.1:3307 / sandy_test_local).
 *
 * The REAL handler (pages/api/contact.ts) is invoked with fake req/res objects. The table is created
 * ONLY from migrations/0001-contact-messages.sql (the handler no longer creates it). For isolation the
 * test drops and recreates contact_messages in sandy_test_local, and refuses to run on any other database.
 *
 * Env: SANDY_TEST_DB_PASSWORD
 * Run: node tests/contact-api.test.mjs
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const DB_NAME = "sandy_test_local";
const realPool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: DB_NAME,
  charset: "utf8mb4",
  connectionLimit: 2,
});

// lib/db.ts reads globalThis._mysqlPool on every access, so swapping it swaps the handler's pool.
globalThis._mysqlPool = realPool;

const { __rateLimitTestUtils } = await import(pathToFileURL(path.join(root, "lib/rateLimit.ts")).href);
const handler = (await import(pathToFileURL(path.join(root, "pages/api/contact.ts")).href)).default;

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};

function makeReq(body, { method = "POST", ip = "203.0.113.10" } = {}) {
  return {
    method,
    url: "/api/contact",
    query: {},
    headers: { host: "contact.test", "x-forwarded-for": ip },
    cookies: {},
    body,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

/** Clears the rate-limit store first, unless opts.keepLimits is set (used by the 429 test). */
async function call(body, opts = {}) {
  if (!opts.keepLimits) __rateLimitTestUtils.clearStore();
  const res = makeRes();
  await handler(makeReq(body, opts), res);
  return res;
}

async function rowCount() {
  const [rows] = await realPool.query("SELECT COUNT(*) AS n FROM contact_messages");
  return Number(rows[0].n);
}

const validBody = () => ({
  name: "Test Person",
  email: "test.person@example.com",
  phone: "+92 300 0000000",
  subject: "Order Query",
  message: "Hello there",
});

let sections = 0;
async function section(name, fn) {
  __rateLimitTestUtils.clearStore();
  try {
    await fn();
    sections += 1;
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

try {
  // ---- setup: only from the migration file, in the dedicated test database
  const [[dbRow]] = await realPool.query("SELECT DATABASE() AS db");
  eq(dbRow.db, DB_NAME, "refusing to run outside the test database");
  const migration = readFileSync(path.join(root, "migrations", "0001-contact-messages.sql"), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  await realPool.query("DROP TABLE IF EXISTS contact_messages");
  await realPool.query(migration);
  await realPool.query(migration); // idempotent: second run must not fail

  await section("valid insert", async () => {
    const res = await call({
      ...validBody(),
      name: "  Ali\u0000 Khan\u0007  ",
      message: "Line one\r\nLine two\u0001\n  tail  ",
    });
    eq(res.statusCode, 200);
    eq(res.body, { success: true });
    const [rows] = await realPool.query("SELECT name, email, phone, subject, message FROM contact_messages");
    eq(rows.length, 1);
    eq(rows[0].name, "Ali Khan", "control chars stripped and trimmed");
    eq(rows[0].email, "test.person@example.com");
    eq(rows[0].phone, "+92 300 0000000");
    eq(rows[0].subject, "Order Query");
    eq(rows[0].message, "Line one\nLine two\n  tail", "newlines kept in message, control chars stripped");
  });

  await section("optional fields may be omitted", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    const res = await call({ name: "N", email: "n@example.com", message: "M" });
    eq(res.statusCode, 200);
    const [rows] = await realPool.query("SELECT phone, subject FROM contact_messages");
    eq(rows, [{ phone: "", subject: "" }]);
  });

  await section("method and body shape", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    const get = await call(undefined, { method: "GET" });
    eq(get.statusCode, 405);
    eq(get.body, { error: "Method not allowed" });
    for (const bad of [undefined, null, "text", 42, ["a"]]) {
      const res = await call(bad);
      eq(res.statusCode, 400, `body ${JSON.stringify(bad)}`);
      eq(res.body, { error: "Invalid input" });
    }
    eq(await rowCount(), 0);
  });

  await section("missing required fields -> 400", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    for (const key of ["name", "email", "message"]) {
      for (const value of [undefined, "", "   "]) {
        const body = validBody();
        if (value === undefined) delete body[key];
        else body[key] = value;
        const res = await call(body);
        eq(res.statusCode, 400, `${key}=${JSON.stringify(value)}`);
        eq(res.body, { error: "Missing required fields" });
      }
    }
    eq(await rowCount(), 0);
  });

  await section("invalid / oversize input -> 400", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    const cases = {
      "name 256": { name: "n".repeat(256) },
      "email 256": { email: `${"e".repeat(250)}@x.com` },
      "phone 51": { phone: "1".repeat(51) },
      "subject 256": { subject: "s".repeat(256) },
      "message 5001": { message: "m".repeat(5001) },
      "bad email": { email: "not-an-email" },
      "email with space": { email: "a b@example.com" },
      "name not a string": { name: 123 },
      "name object": { name: { $ne: "" } },
      "phone array": { phone: ["1"] },
      "subject number": { subject: 5 },
      "message array": { message: ["hi"] },
    };
    for (const [label, patch] of Object.entries(cases)) {
      const res = await call({ ...validBody(), ...patch });
      eq(res.statusCode, 400, label);
      eq(res.body, { error: "Invalid input" }, label);
    }
    eq(await rowCount(), 0);
    // exact limits are accepted
    __rateLimitTestUtils.clearStore();
    const edge = await call({
      name: "n".repeat(255),
      email: `${"e".repeat(243)}@example.com`, // 255 chars
      phone: "1".repeat(50),
      subject: "s".repeat(255),
      message: "m".repeat(5000),
    });
    eq(edge.statusCode, 200);
    eq(await rowCount(), 1);
  });

  await section("honeypot -> 200 and ZERO rows", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    for (const website of ["http://spam.example", "  x  ", 1, { a: 1 }]) {
      const res = await call({ ...validBody(), website });
      eq(res.statusCode, 200);
      eq(res.body, { success: true });
    }
    eq(await rowCount(), 0, "honeypot must insert nothing");
    // Empty / whitespace honeypot is a normal submission
    __rateLimitTestUtils.clearStore();
    const real = await call({ ...validBody(), website: "   " });
    eq(real.statusCode, 200);
    eq(await rowCount(), 1);
  });

  await section("6th request from the same IP -> 429", async () => {
    await realPool.query("TRUNCATE TABLE contact_messages");
    for (let i = 1; i <= 5; i += 1) {
      const res = await call(validBody(), { ip: "198.51.100.7", keepLimits: true });
      eq(res.statusCode, 200, `request ${i}`);
    }
    const sixth = await call(validBody(), { ip: "198.51.100.7", keepLimits: true });
    eq(sixth.statusCode, 429);
    eq(sixth.body, { error: "Too many requests" });
    eq(await rowCount(), 5, "the limited request must not insert");
    const other = await call(validBody(), { ip: "198.51.100.8", keepLimits: true });
    eq(other.statusCode, 200, "another IP is unaffected");
  });

  await section("500 -> generic body, nothing leaked", async () => {
    const secret = "SECRET-DB-DETAIL-HOST-10.1.2.3";
    const body = { ...validBody(), name: "PII-Name-Zed", email: "pii.zed@example.com", message: "PII-Message-Zed" };
    const logged = [];
    const originalError = console.error;
    const originalPool = globalThis._mysqlPool;
    console.error = (...args) => logged.push(args);
    globalThis._mysqlPool = {
      query: async () => {
        const err = new Error(`connect ECONNREFUSED ${secret} ${body.email} ${body.message}`);
        err.code = "ECONNREFUSED";
        throw err;
      },
    };
    let res;
    try {
      res = await call(body);
    } finally {
      console.error = originalError;
      globalThis._mysqlPool = originalPool;
    }
    eq(res.statusCode, 500);
    eq(res.body, { error: "Server error" });
    ok(!JSON.stringify(res.body).includes(secret));
    ok(logged.length >= 1, "server logs a tagged error");
    const logText = JSON.stringify(logged);
    ok(logged.every((args) => String(args[0]).startsWith("[contact]")), "log is tagged [contact]");
    for (const needle of [secret, body.email, body.message, "PII-Name-Zed"]) {
      ok(!logText.includes(needle), `log must not contain ${needle}`);
    }
  });

  console.log("CONTACT_API_PASS", JSON.stringify({ sections, assertions }));
} finally {
  await realPool.end();
}
process.exit(0);
