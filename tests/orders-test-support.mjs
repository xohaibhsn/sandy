/**
 * Shared helpers for the SANDY-BATCH-05 Phase 2 order tests (not a test itself).
 *
 * The orders tests run the REAL pages/api handlers in-process against a MariaDB database that is
 * built ONLY from migrations/0001 + migrations/0002 + the tax SQL (no runtime DDL exists any more).
 *
 *   Database : sandy_mig_orders on 127.0.0.1:3307 (dedicated local test DB; any other name is refused)
 *   Env      : SANDY_TEST_DB_PASSWORD (required, never printed)
 *              SANDY_TAX_SQL (optional) path to 01-tax-config-migrate.sql
 *
 * Do not run the orders tests in parallel: they share this one database.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DB_NAME = "sandy_mig_orders";

const DEFAULT_TAX_SQL =
  "C:/Users/LENOVO/OneDrive/Desktop/Web Dev/sandy-artifacts/SANDY-BATCH-01/phase3/sql/01-tax-config-migrate.sql";

export function requirePassword() {
  if (!process.env.SANDY_TEST_DB_PASSWORD) {
    console.error("SANDY_TEST_DB_PASSWORD is required");
    process.exit(2);
  }
}

/** Maps extensionless relative imports in the TS sources to `.ts` (same hook the other tests use). */
export function installTsResolveHook() {
  process.removeAllListeners("warning");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        // tsconfig path alias used by lib/contact-config.ts
        const target = pathToFileURL(path.join(root, specifier.slice(2))).href;
        return nextResolve(/\.[mc]?[jt]sx?$/.test(target) ? target : `${target}.ts`, context);
      }
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          /* fall through */
        }
        // directory import (e.g. ../../lib/otp -> lib/otp/index.ts)
        try {
          return nextResolve(`${specifier.replace(/\/$/, "")}/index.ts`, context);
        } catch {
          /* fall through */
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

export function importFromRoot(rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

function connect(multi) {
  return mysql.createConnection({
    host: "127.0.0.1",
    port: 3307,
    user: "sandy_test",
    password: process.env.SANDY_TEST_DB_PASSWORD,
    database: DB_NAME,
    multipleStatements: multi,
    charset: "utf8mb4",
  });
}

export function createPool() {
  return mysql.createPool({
    host: "127.0.0.1",
    port: 3307,
    user: "sandy_test",
    password: process.env.SANDY_TEST_DB_PASSWORD,
    database: DB_NAME,
    charset: "utf8mb4",
    connectionLimit: 4,
  });
}

/**
 * Drops every table in the dedicated DB, then rebuilds it from the SQL files only.
 * Extra fixtures that are NOT part of the shop migrations (they have their own owner SQL / are created
 * by other routes): coupons, the cancel_reason column, and an 18% GST rate row (the tax SQL seeds 17%).
 */
export async function rebuildFromMigrations() {
  const c = await connect(true);
  try {
    const [[{ d }]] = await c.query("SELECT DATABASE() AS d");
    if (d !== DB_NAME) throw new Error("refusing to run against any database other than the dedicated test DB");

    const [tables] = await c.query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    await c.query("SET FOREIGN_KEY_CHECKS=0");
    for (const t of tables) await c.query(`DROP TABLE IF EXISTS \`${t.TABLE_NAME}\``);
    await c.query("SET FOREIGN_KEY_CHECKS=1");

    const taxSql = process.env.SANDY_TAX_SQL || DEFAULT_TAX_SQL;
    if (!existsSync(taxSql)) throw new Error("tax migration SQL not found (set SANDY_TAX_SQL)");

    await c.query(readFileSync(path.join(root, "migrations/0001-contact-messages.sql"), "utf8"));
    await c.query(readFileSync(path.join(root, "migrations/0002-shop-schema.sql"), "utf8"));
    await c.query(readFileSync(taxSql, "utf8"));
    // admin tables (coupons, admin_sessions, ...) come from 0003 too; no default content is seeded here (no 0004).
    await c.query(readFileSync(path.join(root, "migrations/0003-admin-schema.sql"), "utf8"));
    await c.query(readFileSync(path.join(root, "migrations/0005-orders-cancel-reason.sql"), "utf8"));
    await c.query(readFileSync(path.join(root, "migrations/0006-customer-protection.sql"), "utf8"));
    await c.query(readFileSync(path.join(root, "migrations/0007-orders-protection-columns.sql"), "utf8"));
    await c.query(readFileSync(path.join(root, "migrations/0008-customer-accounts.sql"), "utf8"));

    // --- fixtures outside the migrations
    await c.query(
      `INSERT INTO tax_rates (tax_class_id, rate_percent, effective_from, created_by)
       SELECT id, 18.0000, '2021-01-01 00:00:00', 'phase2-test' FROM tax_classes`
    );
  } finally {
    await c.end();
  }
}

export async function one(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows[0] : undefined;
}

export async function count(pool, sql, params = []) {
  return Number((await one(pool, sql, params))?.c || 0);
}

export function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
}

export function makeReq({ method = "POST", url = "/api/x", body, query = {}, cookies = {}, headers = {}, ip = "203.0.113.50" } = {}) {
  return {
    method,
    url,
    query,
    headers: { host: "orders.test", "x-forwarded-for": ip, ...headers },
    cookies,
    body,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

export async function invoke(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

export function checkoutBody(overrides = {}) {
  return {
    customer_name: "Test Customer",
    customer_email: "customer@example.test",
    customer_phone: "03331234567",
    delivery_address: "House 1, Street 2",
    city: "Lahore",
    postcode: "54000",
    notes: "",
    payment_method: "cod",
    items: [],
    idempotency_key: crypto.randomUUID(),
    ...overrides,
  };
}

/** Mints a super_admin session directly in the test DB and returns the cookie token. */
export async function mintAdminToken(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY, token_hash CHAR(64) NOT NULL, staff_id INT NULL,
      is_master TINYINT(1) NOT NULL DEFAULT 0, role VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_sessions_token_hash (token_hash),
      KEY idx_admin_sessions_expires_at (expires_at))`);
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, 1, "super_admin", "phase2-test", expires]
  );
  return raw;
}

export function adminReq(token, extra = {}) {
  return {
    cookies: { sAdminSession: token },
    headers: { origin: "http://orders.test" },
    ...extra,
  };
}

export function makeAssertions(assert) {
  let n = 0;
  return {
    eq(a, b, m) {
      n += 1;
      assert.deepEqual(a, b, m);
    },
    ok(v, m) {
      n += 1;
      assert.ok(v, m);
    },
    total: () => n,
  };
}
