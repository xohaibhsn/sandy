/**
 * HTTP auth/validation checks against a local next server (DB = sandy_test_local).
 * Env: BASE_URL, SANDY_TEST_DB_PASSWORD, and optional SESSION cookies created here.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4320";
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
  const tokenHash = hashSessionToken(raw);
  const expires = new Date(Date.now() + 7 * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at)
     VALUES (?,?,?,?,?,?)`,
    [tokenHash, null, role === "super_admin" ? 1 : 0, role, `dash-${role}`, expires]
  );
  return raw;
}

async function hit(path, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = `sAdminSession=${cookie}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

async function main() {
  await ensureSessions();
  const writer = await mint("writer");
  const manager = await mint("manager");
  const superAdmin = await mint("super_admin");

  const unauth = await hit("/api/admin-dashboard-summary?preset=all");
  assert.equal(unauth.status, 401, `unauth expected 401 got ${unauth.status} ${unauth.text}`);

  const w = await hit("/api/admin-dashboard-summary?preset=all", writer);
  assert.equal(w.status, 403, `writer expected 403 got ${w.status} ${w.text}`);

  const m = await hit("/api/admin-dashboard-summary?preset=all", manager);
  assert.equal(m.status, 200, `manager expected 200 got ${m.status} ${m.text}`);
  assert.equal(m.json?.success, true);

  const s = await hit("/api/admin-dashboard-summary?preset=all", superAdmin);
  assert.equal(s.status, 200);
  assert.equal(s.json?.success, true);

  const badPreset = await hit("/api/admin-dashboard-summary?preset=nope", manager);
  assert.equal(badPreset.status, 400);

  const badCustom = await hit("/api/admin-dashboard-summary?preset=custom&from=bad&to=2026-01-01", manager);
  assert.equal(badCustom.status, 400);

  const badOrder = await hit("/api/admin-dashboard-summary?preset=custom&from=2026-12-01&to=2026-01-01", manager);
  assert.equal(badOrder.status, 400);

  console.log("DASHBOARD_AUTH_HTTP_PASS", {
    unauth: unauth.status,
    writer: w.status,
    manager: m.status,
    super_admin: s.status,
    badPreset: badPreset.status,
    totals: { total_orders: s.json?.total_orders, revenue: s.json?.revenue },
  });

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
